const crypto = require("crypto");
const { io } = require("socket.io-client");
const { generateSocketTopic } = require("./unaiApi");
const { refreshAccessToken } = require("./unaiAuth");
const TagEvent = require("../models/TagEvent");
const { getAssetTagIds, isAssetOrKnownAsset } = require("./assetFilter");

// HISTORICAL SOCKET COLLECTOR
// ---------------------------
// One backend Socket.IO connection subscribes to every known floor topic.
// The UNAI Postman documentation specifies socketx.lailab.online with
// handshake path /ble/location5, query parameter token, and /join messages
// such as: unai/[encrypt_topic]/tag.

let socket = null;
let started = false;
let state = "STOPPED";
let reconnectTimer = null;
let healthTimer = null;
let reconnectAttempt = 0;
let cooldownUntil = 0;
let currentTopics = [];
let lastMessageAt = 0;
let lastConnectedAt = 0;
let lastError = null;
let lastSocketEvent = null;
let savedEventCount = 0;
let ignoredAssetCount = 0;
let invalidRecordCount = 0;

const lastSavedPositions = new Map();
let saveQueue = Promise.resolve();

// UNAI Postman: https://socketx.lailab.online + /ble/location5
const SOCKET_URL = process.env.UNAI_SOCKET_URL || "https://socketx.lailab.online";
const SOCKET_PATH = process.env.UNAI_SOCKET_PATH || "/ble/location5";
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const SAVE_INTERVAL_MS = Math.max(
  500,
  Number(process.env.TAG_HISTORY_SAVE_INTERVAL_MS) || 2_000,
);
const HEALTH_LOG_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.HISTORY_SOCKET_HEALTH_INTERVAL_MS) || 30_000,
);

function log(...args) {
  console.log("[HistoryCollector]", ...args);
}

function setState(next) {
  state = next;
  log(`STATE=${next}`);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstValue(object, keys) {
  const item = asObject(object);
  if (!item) return undefined;
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
      return item[key];
    }
  }
  return undefined;
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampValue(value) {
  if (typeof value === "number") {
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
      const numericDate = new Date(ms);
      if (!Number.isNaN(numericDate.getTime())) return numericDate;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

function timestampFromRecord(record) {
  return firstValue(record, [
    "timestamp",
    "time",
    "unix_time",
    "unixTime",
    "adapter_time_start",
    "adapterTimeStart",
    "messagetimestamp",
    "messageTimestamp",
    "lastSeenAt",
    "last_seen",
    "date_now",
    "created_at",
    "createdAt",
  ]);
}

function tagIdOf(value) {
  const item = asObject(value);
  if (!item) return null;

  // UNAI tag stream examples use `id`; other project/API responses use tagId.
  const direct = firstValue(item, [
    "tagId",
    "tag_id",
    "tagID",
    "tag_key",
    "id",
  ]);
  if (direct !== undefined) return String(direct);

  const nested = asObject(item.tag);
  const nestedId = firstValue(nested, [
    "id",
    "tagId",
    "tag_id",
    "tagID",
    "tag_key",
  ]);
  return nestedId === undefined ? null : String(nestedId);
}

function floorIdOf(value) {
  const item = asObject(value);
  if (!item) return null;

  // UNAI socket payload uses `floor`; support both socket and API naming.
  const direct = firstValue(item, [
    "floorId",
    "floor_id",
    "floorID",
    "floor",
  ]);
  if (direct !== undefined && typeof direct !== "object") return String(direct);

  const location = asObject(item.location);
  const locationFloor = firstValue(location, [
    "floorId",
    "floor_id",
    "floorID",
    "floor",
  ]);
  return locationFloor === undefined ? null : String(locationFloor);
}

function buildingIdOf(value) {
  const item = asObject(value);
  if (!item) return null;

  // UNAI socket payload uses `building`; support both socket and API naming.
  const direct = firstValue(item, [
    "buildingId",
    "building_id",
    "buildingID",
    "building",
  ]);
  if (direct !== undefined && typeof direct !== "object") return String(direct);

  const location = asObject(item.location);
  const locationBuilding = firstValue(location, [
    "buildingId",
    "building_id",
    "buildingID",
    "building",
  ]);
  return locationBuilding === undefined ? null : String(locationBuilding);
}

function isAsset(value) {
  const item = asObject(value);
  if (!item) return false;
  const usageType =
    item.usage_type ??
    item.usageType ??
    asObject(item.usage)?.type ??
    asObject(item.tag)?.usage_type ??
    asObject(item.tag)?.usageType;
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function filterAssetPayload(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isAsset(item))
      .map(filterAssetPayload)
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") return value;
  if (isAsset(value)) return undefined;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") {
      const filtered = filterAssetPayload(child);
      if (filtered !== undefined) result[key] = filtered;
    } else {
      result[key] = child;
    }
  }
  return result;
}

function collectLocationRecords(value, output = [], parentContext = {}) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    value.forEach((item) => collectLocationRecords(item, output, parentContext));
    return output;
  }

  const object = value;
  const context = {
    floorId: floorIdOf(object) ?? parentContext.floorId ?? null,
    buildingId: buildingIdOf(object) ?? parentContext.buildingId ?? null,
  };

  const tagId = tagIdOf(object);
  const x = numberValue(
    firstValue(object, [
      "x",
      "pos_x",
      "position_x",
      "location_x",
      "coordinate_x",
    ]),
  );
  const y = numberValue(
    firstValue(object, [
      "y",
      "pos_y",
      "position_y",
      "location_y",
      "coordinate_y",
    ]),
  );

  if (tagId && x !== null && y !== null) {
    output.push({
      tagId,
      floorId: context.floorId,
      buildingId: context.buildingId,
      x,
      y,
      z: numberValue(
        firstValue(object, [
          "z",
          "pos_z",
          "position_z",
          "location_z",
          "coordinate_z",
        ]),
      ),
      timestamp: timestampValue(timestampFromRecord(object)),
      groupId: firstValue(object, ["groupId", "group_id"]),
      groupName: firstValue(object, ["groupName", "group_name"]),
      tagName: firstValue(object, [
        "tagName",
        "tag_name",
        "name",
        "label",
        "ui_display",
      ]),
      rawData: object,
    });
  }

  for (const child of Object.values(object)) {
    if (child && typeof child === "object") {
      collectLocationRecords(child, output, context);
    }
  }

  return output;
}

function eventKeyFor(record) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        record.tagId,
        record.buildingId ?? null,
        record.floorId ?? null,
        record.x,
        record.y,
        record.z ?? null,
        record.timestamp.toISOString(),
      ]),
    )
    .digest("hex");
}

function normalizeTopic(topic) {
  if (!topic || typeof topic !== "object") return null;
  const floorId = firstValue(topic, ["floorId", "floor_id", "id"]);
  const buildingId = firstValue(topic, ["buildingId", "building_id"]);
  const encryptTopic = firstValue(topic, [
    "encryptTopic",
    "encrypt_topic",
    "topic",
  ]);
  const socketToken = firstValue(topic, ["socketToken", "socket_token"]);

  if (floorId === undefined || !encryptTopic) return null;

  return {
    floorId: String(floorId),
    buildingId: buildingId === undefined ? null : String(buildingId),
    encryptTopic: String(encryptTopic),
    socketToken: socketToken ? String(socketToken) : null,
  };
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  const result = [];
  const seen = new Set();

  for (const item of topics) {
    const topic = normalizeTopic(item);
    if (!topic) continue;
    const key = `${topic.floorId}:${topic.encryptTopic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(topic);
  }

  return result;
}

function extractSocketToken(topics) {
  return topics.find((topic) => topic.socketToken)?.socketToken || null;
}

function isRateLimitError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return (
    text.includes("too many connection attempts") ||
    text.includes("rate limit") ||
    text.includes("rate_limited") ||
    (text.includes("rate") && text.includes("limit"))
  );
}

function isUnauthorizedError(error) {
  const status = Number(error?.data?.status ?? error?.status);
  const message = String(error?.message || error || "").toLowerCase();
  return status === 401 || status === 403 || message.includes("unauthorized");
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearHealthTimer() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function closeSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function backoffDelay() {
  const exponent = Math.min(reconnectAttempt, 6);
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** exponent);
  const jitter = Math.floor(Math.random() * 1_000);
  reconnectAttempt += 1;
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

function scheduleReconnect(reason, explicitDelay = null) {
  if (!started || reconnectTimer) return;

  let delay = explicitDelay;
  if (delay == null) {
    delay = reason === "rate_limit"
      ? Math.max(1_000, cooldownUntil - Date.now())
      : backoffDelay();
  }

  setState(reason === "rate_limit" ? "RATE_LIMITED" : "BACKOFF");
  log(`Reconnect scheduled in ${delay}ms (${reason})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function startHealthMonitor() {
  clearHealthTimer();

  healthTimer = setInterval(() => {
    if (!started) return;

    const now = Date.now();
    const secondsSinceMessage = lastMessageAt
      ? Math.round((now - lastMessageAt) / 1000)
      : null;

    log("HEALTH", {
      state,
      connected: Boolean(socket?.connected),
      topics: currentTopics.length,
      savedEvents: savedEventCount,
      ignoredAssets: ignoredAssetCount,
      invalidRecords: invalidRecordCount,
      secondsSinceLastMessage: secondsSinceMessage,
      lastSocketEvent,
      lastError,
    });
  }, HEALTH_LOG_INTERVAL_MS);
}

function resolveTopicForRecord(record) {
  const floorId = record.floorId == null ? null : String(record.floorId);
  const buildingId = record.buildingId == null ? null : String(record.buildingId);

  if (floorId) {
    const byFloor = currentTopics.find((topic) => topic.floorId === floorId);
    if (byFloor) return byFloor;
  }

  if (buildingId) {
    const byBuilding = currentTopics.find((topic) => topic.buildingId === buildingId);
    if (byBuilding) return byBuilding;
  }

  if (currentTopics.length === 1) return currentTopics[0];
  return null;
}

function enqueueHistorySave(records) {
  if (!records.length) return;

  saveQueue = saveQueue
    .then(async () => {
      const assetTagIds = await getAssetTagIds();
      const documents = [];
      const now = Date.now();

      for (const record of records) {
        if (isAsset(record) || isAssetOrKnownAsset(record, assetTagIds)) {
          ignoredAssetCount += 1;
          continue;
        }

        const topic = resolveTopicForRecord(record);
        if (!topic) {
          invalidRecordCount += 1;
          log("SKIP ambiguous floor for tag", record.tagId);
          continue;
        }

        const normalizedFloorId = record.floorId ?? topic.floorId;
        const normalizedBuildingId = record.buildingId ?? topic.buildingId;
        const key = String(record.tagId);
        const previous = lastSavedPositions.get(key);
        const positionChanged =
          !previous ||
          previous.x !== record.x ||
          previous.y !== record.y ||
          previous.z !== record.z ||
          previous.floorId !== String(normalizedFloorId);
        const enoughTimePassed =
          !previous || now - previous.savedAt >= SAVE_INTERVAL_MS;

        if (!positionChanged && !enoughTimePassed) continue;

        const document = {
          tagId: key,
          buildingId: normalizedBuildingId == null ? null : String(normalizedBuildingId),
          floorId: normalizedFloorId == null ? null : String(normalizedFloorId),
          groupId: record.groupId ?? null,
          groupName: record.groupName == null ? null : String(record.groupName),
          tagName: record.tagName == null ? null : String(record.tagName),
          event: "position_update",
          status: "ALIVE",
          movementStatus: positionChanged ? "MOVING" : "STATIONARY",
          isAsset: false,
          x: record.x,
          y: record.y,
          z: record.z,
          timestamp: record.timestamp,
          receivedAt: new Date(),
          eventKey: eventKeyFor({
            ...record,
            buildingId: normalizedBuildingId,
            floorId: normalizedFloorId,
          }),
          rawData: filterAssetPayload(record.rawData),
        };

        documents.push(document);
        lastSavedPositions.set(key, {
          x: record.x,
          y: record.y,
          z: record.z,
          floorId: String(normalizedFloorId),
          savedAt: now,
        });
      }

      if (!documents.length) return;

      try {
        const inserted = await TagEvent.insertMany(documents, { ordered: false });
        savedEventCount += inserted.length;
        log(`HISTORY SAVED count=${inserted.length}`);
      } catch (error) {
        const duplicateOnly =
          error?.code === 11000 ||
          (Array.isArray(error?.writeErrors) &&
            error.writeErrors.every((item) => item?.code === 11000));

        if (duplicateOnly) {
          log("Duplicate history event ignored by eventKey index");
        } else {
          throw error;
        }
      }
    })
    .catch((error) => {
      log("HISTORY SAVE ERROR:", error?.message || error);
      lastError = error?.message || String(error);
    });
}

function handleTagPayload(payload) {
  lastMessageAt = Date.now();

  const filteredPayload = filterAssetPayload(payload);
  if (filteredPayload === undefined) return;

  const records = collectLocationRecords(filteredPayload);
  log(`PAYLOAD event=${lastSocketEvent} records=${records.length}`);

  if (!records.length) {
    // Keep a compact payload sample visible when UNAI changes its envelope.
    log("PAYLOAD SAMPLE", JSON.stringify(payload).slice(0, 3000));
    return;
  }

  enqueueHistorySave(records);
}

function subscribeTopic(topic) {
  const tagTopic = `unai/${topic.encryptTopic}/tag`;
  socket.emit("/join", tagTopic);
  log(`JOIN floor=${topic.floorId} topic=${tagTopic}`);
  log("JOIN SENT", { floorId: topic.floorId, topic: tagTopic });
}

async function regenerateTopics() {
  const nextTopics = [];

  for (const topic of currentTopics) {
    try {
      const result = await generateSocketTopic(topic.floorId);
      nextTopics.push({
        ...topic,
        socketToken: result.socket_token,
        encryptTopic: result.encrypt_topic || topic.encryptTopic,
      });
    } catch (error) {
      log(`Topic generation failed floor=${topic.floorId}:`, error?.message || error);
    }
  }

  if (nextTopics.length) currentTopics = normalizeTopics(nextTopics);
  return currentTopics;
}

async function connect() {
  if (!started) return;
  if (Date.now() < cooldownUntil) {
    scheduleReconnect("rate_limit");
    return;
  }
  if (socket?.connected || socket?.connecting) return;

  const token = extractSocketToken(currentTopics);
  if (!token) {
    setState("WAITING_FOR_TOKEN");
    log("No socket_token available; waiting for topic generation");
    return;
  }

  closeSocket();
  setState("CONNECTING");
  lastError = null;
  lastSocketEvent = null;
  log(`CONNECT ${SOCKET_URL}${SOCKET_PATH} topics=${currentTopics.length}`);

  socket = io(SOCKET_URL, {
    path: SOCKET_PATH,
    query: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    timeout: 10_000,
  });

  // Critical diagnostic: do not guess UNAI's event envelope. This shows the
  // actual event names emitted by the upstream Socket.IO server.
  socket.onAny((event, ...args) => {
    lastSocketEvent = event;
    log(
      "SOCKET EVENT",
      event,
      JSON.stringify(args).slice(0, 5000),
    );
  });

  socket.on("connect", () => {
    reconnectAttempt = 0;
    cooldownUntil = 0;
    lastConnectedAt = Date.now();
    lastError = null;
    setState("CONNECTED");
    log(`CONNECTED socketId=${socket.id}`);

    // Keep register for deployments that expose it; /join is the documented
    // subscription mechanism and is sent immediately after registration.
    socket.emit("/register", { customId: "backend_history_collector" });
    currentTopics.forEach(subscribeTopic);
  });

  socket.on("connect_error", async (error) => {
    lastError = error?.message || String(error);
    log("CONNECT ERROR:", lastError);

    if (isRateLimitError(error)) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      closeSocket();
      scheduleReconnect("rate_limit");
      return;
    }

    if (isUnauthorizedError(error)) {
      closeSocket();
      setState("REFRESHING_TOKEN");
      try {
        await refreshAccessToken();
        await regenerateTopics();
        scheduleReconnect("unauthorized", 5_000);
      } catch (refreshError) {
        lastError = refreshError?.message || String(refreshError);
        log("TOKEN REFRESH ERROR:", lastError);
        scheduleReconnect("token_refresh_error");
      }
      return;
    }

    closeSocket();
    scheduleReconnect("connect_error");
  });

  socket.on("disconnect", (reason) => {
    log("DISCONNECTED:", reason);
    socket = null;
    if (started) scheduleReconnect("disconnect");
  });

  // UNAI Postman documents clientBox for general data. Keep the compatibility
  // listeners because some deployments use tag/message for the same payload.
  socket.on("clientBox", handleTagPayload);
  socket.on("tag", handleTagPayload);
  socket.on("message", handleTagPayload);
}

async function refreshTopics(floors = []) {
  const list = Array.isArray(floors) ? floors : [];
  const results = [];

  for (const floor of list) {
    const floorId = firstValue(floor, ["id", "floorId", "floor_id", "floorID"]);
    if (floorId === undefined) continue;

    try {
      const result = await generateSocketTopic(floorId);
      results.push({
        floorId,
        buildingId: firstValue(floor, ["buildingId", "building_id", "buildingID"]),
        socket_token: result.socket_token,
        encrypt_topic: result.encrypt_topic,
      });
    } catch (error) {
      log(`Topic generation failed floor=${floorId}:`, error?.message || error);
    }
  }

  currentTopics = normalizeTopics(results);
  log(`TOPICS loaded=${currentTopics.length}`);
  return currentTopics;
}

async function start(options = {}) {
  if (started) return getStatus();

  started = true;
  setState("STARTING");
  startHealthMonitor();

  try {
    await refreshTopics(options.floors || []);

    if (!currentTopics.length) {
      setState("WAITING_FOR_TOPICS");
      log("No valid floor topics; collector will not create a socket connection");
      return getStatus();
    }

    await connect();
  } catch (error) {
    lastError = error?.message || String(error);
    log("START ERROR:", lastError);
    scheduleReconnect("start_error");
  }

  return getStatus();
}

function stop() {
  started = false;
  clearReconnectTimer();
  clearHealthTimer();
  cooldownUntil = 0;
  reconnectAttempt = 0;
  closeSocket();
  currentTopics = [];
  lastSavedPositions.clear();
  setState("STOPPED");
}

function getStatus() {
  return {
    started,
    state,
    connected: Boolean(socket?.connected),
    socketId: socket?.id || null,
    socketUrl: SOCKET_URL,
    socketPath: SOCKET_PATH,
    topicCount: currentTopics.length,
    reconnectAttempt,
    cooldownUntil: cooldownUntil || null,
    lastConnectedAt: lastConnectedAt || null,
    lastMessageAt: lastMessageAt || null,
    lastSocketEvent,
    lastError,
    savedEventCount,
    ignoredAssetCount,
    invalidRecordCount,
    saveIntervalMs: SAVE_INTERVAL_MS,
  };
}

module.exports = {
  start,
  stop,
  connect,
  refreshTopics,
  getStatus,
};
