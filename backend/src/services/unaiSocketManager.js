const crypto = require("crypto");
const { io } = require("socket.io-client");
const { generateSocketTopic } = require("./unaiApi");
const { refreshAccessToken } = require("./unaiAuth");
const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, isAssetOrKnownAsset } = require("./assetFilter");
const { evaluateRecord } = require("./anomalyDetector");

// HISTORICAL SOCKET COLLECTOR
// ---------------------------
// One backend Socket.IO connection subscribes to every known floor topic.
// Keep the same UNAI Socket endpoint used by the original working Building
// implementation. The new last-location HTTP APIs are only the initial/current
// snapshot; they must never replace the realtime Socket transport.

let socket = null;
let started = false;
let state = "STOPPED";
let reconnectTimer = null;
let topicFallbackTimer = null;
let healthTimer = null;
let reconnectAttempt = 0;
let cooldownUntil = 0;
let currentTopics = [];
let initTopicIndex = 0;
const initAckedEvents = new Map();
const pendingInitRoomJoins = new Map();
// Keep the floor configuration separately from generated socket credentials.
// If UNAI returns HTTP 429 while generating the first topic, currentTopics can
// legitimately be empty. We still need the original floor list so the manager
// can regenerate credentials after the cooldown instead of getting stuck in
// WAITING_FOR_TOKEN forever.
let configuredFloors = [];
let lastMessageAt = 0;
let lastTagMessageAt = 0;
let lastConnectedAt = 0;
let lastError = null;
let lastSocketEvent = null;
let savedEventCount = 0;
let ignoredAssetCount = 0;
let invalidRecordCount = 0;

// Frontend realtime subscribers receive normalized, already asset-filtered
// records from this single backend collector. Pages never connect directly to
// the UNAI socket, so opening Home in several tabs does not multiply upstream
// connections or consume the UNAI connection-attempt limit.
const realtimeListeners = new Set();

const lastSavedPositions = new Map();
let saveQueue = Promise.resolve();

// IMPORTANT: these defaults intentionally preserve the endpoint used by the
// original working Building/LiveMap flow. They can still be overridden through
// UNAI_SOCKET_URL / UNAI_SOCKET_PATH when a deployment explicitly requires it.
const SOCKET_URL = process.env.UNAI_SOCKET_URL || "https://socket.lailab.online";
const SOCKET_PATH = process.env.UNAI_SOCKET_PATH || "/ble/location";
const MAX_BACKOFF_MS = 60_000;
const UPSTREAM_UNAVAILABLE_BACKOFF_MS = 30_000;
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

function coordinateValue(object, axis) {
  const item = asObject(object);
  if (!item) return null;

  const axisKeys = {
    x: ["x", "pos_x", "position_x", "location_x", "coordinate_x"],
    y: ["y", "pos_y", "position_y", "location_y", "coordinate_y"],
    z: ["z", "pos_z", "position_z", "location_z", "coordinate_z"],
  };

  const direct = firstValue(item, axisKeys[axis]);
  const directNumber = numberValue(direct);
  if (directNumber !== null) return directNumber;

  const coordinates = item.coordinates ?? item.coordinate ?? item.coords;
  if (Array.isArray(coordinates)) {
    const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    return numberValue(coordinates[index]);
  }

  const xyz = item.xyz;
  if (Array.isArray(xyz)) {
    const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    return numberValue(xyz[index]);
  }

  if (xyz && typeof xyz === "object") {
    const xyzObject = asObject(xyz);
    const value = firstValue(xyzObject, axisKeys[axis]);
    return numberValue(value);
  }

  return null;
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

function placeIdOf(value) {
  const item = asObject(value);
  if (!item) return null;
  const direct = firstValue(item, ["placeId", "place_id", "placeID", "place"]);
  if (direct !== undefined && typeof direct !== "object") return String(direct);
  const location = asObject(item.location);
  const nested = firstValue(location, ["placeId", "place_id", "placeID", "place"]);
  return nested === undefined ? null : String(nested);
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

function tagIdFromObjectKey(key) {
  if (key === undefined || key === null) return null;
  const text = String(key).trim();
  if (!text || !/^\d+$/.test(text)) return null;
  return text;
}

function collectLocationRecords(value, output = [], parentContext = {}, parentKey = null) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    value.forEach((item) => collectLocationRecords(item, output, parentContext, null));
    return output;
  }

  const object = value;
  const position = asObject(object.position);
  const location = asObject(object.location);
  const context = {
    placeId: placeIdOf(object) ?? parentContext.placeId ?? null,
    floorId: floorIdOf(object) ?? parentContext.floorId ?? null,
    buildingId: buildingIdOf(object) ?? parentContext.buildingId ?? null,
    tagId: tagIdOf(object) ?? parentContext.tagId ?? tagIdFromObjectKey(parentKey),
  };

  // UNAI has multiple payload envelopes. In particular, some clientBox/tag
  // messages put tagId/floor/building on the parent object and x/y inside a
  // nested `position` or `location` object. The previous collector only read
  // top-level x/y, so it silently produced zero records even though the socket
  // was connected. The browser parser already supported this shape; keep the
  // backend collector equally tolerant so SSE + TagLatest receive movement.
  const x = coordinateValue(object, "x") ?? coordinateValue(position, "x") ?? coordinateValue(location, "x");
  const y = coordinateValue(object, "y") ?? coordinateValue(position, "y") ?? coordinateValue(location, "y");

  if (context.tagId && x !== null && y !== null) {
    output.push({
      tagId: context.tagId,
      placeId: context.placeId,
      floorId: context.floorId,
      buildingId: context.buildingId,
      zoneId: firstValue(object, ["zoneId", "zone_id", "zoneID", "inExpectedZone"]) ?? null,
      zoneName: firstValue(object, ["zoneName", "zone_name", "inExpectedZoneName"]) ?? null,
      x,
      y,
      z: coordinateValue(object, "z") ?? coordinateValue(position, "z") ?? coordinateValue(location, "z"),
      timestamp: timestampValue(timestampFromRecord(object)),
      groupId: firstValue(object, ["groupId", "group_id"]) ?? parentContext.groupId ?? null,
      groupName: firstValue(object, ["groupName", "group_name"]) ?? parentContext.groupName ?? null,
      tagName: firstValue(object, [
        "tagName",
        "tag_name",
        "name",
        "label",
        "ui_display",
      ]) ?? parentContext.tagName ?? null,
      firstName: firstValue(object, ["firstName", "firstname", "first_name"]) ?? null,
      lastName: firstValue(object, ["lastName", "lastname", "last_name"]) ?? null,
      uiDisplay: firstValue(object, ["ui_display", "uiDisplay"]) ?? null,
      tagType: firstValue(object, ["tagType", "tag_type"]) ?? null,
      batteryLevel: numberValue(firstValue(object, ["batteryLevel", "batt", "battery"])),
      placeName: firstValue(object, ["placeName", "place_name"]) ?? null,
      buildingName: firstValue(object, ["buildingName", "building_name"]) ?? null,
      floorName: firstValue(object, ["floorName", "floor_name"]) ?? null,
      lastSeenAt: timestampValue(firstValue(object, ["lastSeenAt", "last_seen", "date_now"])),
      rawData: object,
    });
  }

  // Once this object already produced a location record from its nested
  // position/location fields, do not walk those coordinate containers again;
  // otherwise the same tag update would be emitted twice to SSE/MongoDB.
  for (const [key, child] of Object.entries(object)) {
    if (!child || typeof child !== "object") continue;
    if ((key === "position" || key === "location") && context.tagId && x !== null && y !== null) continue;
    collectLocationRecords(child, output, context, key);
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
  const placeId = firstValue(topic, ["placeId", "place_id"]);
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
    placeId: placeId === undefined ? null : String(placeId),
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
    const key = `${topic.floorId}:${topic.buildingId ?? ""}:${topic.placeId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(topic);
  }

  return result;
}

function extractSocketToken(topics) {
  return topics.find((topic) => topic.socketToken)?.socketToken || null;
}

function getSocketHttpStatus(error) {
  const description = error?.description;

  if (typeof description === "number") return description;

  const candidates = [
    error?.message,
    description?.message,
    description,
    error?.data?.message,
  ];

  for (const candidate of candidates) {
    const text = String(candidate ?? "");
    const match = text.match(/(?:response|status)[^\d]*(\d{3})/i);
    if (match) return Number(match[1]);

    const direct = text.match(/^\s*(4\d\d|5\d\d)\s*$/);
    if (direct) return Number(direct[1]);
  }

  return null;
}

function isUpstreamUnavailableError(error) {
  const status = getSocketHttpStatus(error);
  return status === 502 || status === 503 || status === 504;
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

function clearTopicFallbackTimer() {
  if (topicFallbackTimer) clearTimeout(topicFallbackTimer);
  topicFallbackTimer = null;
}

function clearHealthTimer() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function closeSocket() {
  clearTopicFallbackTimer();
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

async function reconnectAfterCooldown() {
  if (!started) return;

  // A rate-limit can happen before the first socket exists, while generating
  // the floor topic credentials. In that case `connect()` has no token to use.
  // Regenerate the topics from the saved floor configuration first, then make
  // exactly one socket connection attempt.
  if (!currentTopics.length && configuredFloors.length) {
    try {
      await refreshTopics(configuredFloors);
    } catch (error) {
      lastError = error?.message || String(error);
      log("TOPIC RETRY ERROR:", lastError);
      if (Number(error?.status) === 429 || isRateLimitError(error)) {
        const retryAfter = Number(error?.retryAfterMs);
        cooldownUntil = Date.now() + (
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, RATE_LIMIT_COOLDOWN_MS)
            : RATE_LIMIT_COOLDOWN_MS
        );
        scheduleReconnect("rate_limit", Math.max(1_000, cooldownUntil - Date.now()));
      } else {
        scheduleReconnect("topic_retry_error");
      }
      return;
    }
  }

  await connect();
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
    void reconnectAfterCooldown();
  }, delay);
}

function startHealthMonitor() {
  clearHealthTimer();

  healthTimer = setInterval(() => {
    if (!started) return;

    const now = Date.now();
    const secondsSinceMessage = lastTagMessageAt
      ? Math.round((now - lastTagMessageAt) / 1000)
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
          placeId: record.placeId == null ? (topic.placeId == null ? null : String(topic.placeId)) : String(record.placeId),
          buildingId: normalizedBuildingId == null ? null : String(normalizedBuildingId),
          floorId: normalizedFloorId == null ? null : String(normalizedFloorId),
          zoneId: record.zoneId == null ? null : String(record.zoneId),
          zoneName: record.zoneName == null ? null : String(record.zoneName),
          groupId: record.groupId ?? null,
          groupName: record.groupName == null ? null : String(record.groupName),
          tagName: record.tagName == null ? null : String(record.tagName),
          firstName: record.firstName == null ? null : String(record.firstName),
          lastName: record.lastName == null ? null : String(record.lastName),
          uiDisplay: record.uiDisplay == null ? null : String(record.uiDisplay),
          tagType: record.tagType == null ? null : String(record.tagType),
          batteryLevel: record.batteryLevel == null ? null : record.batteryLevel,
          placeName: record.placeName == null ? null : String(record.placeName),
          buildingName: record.buildingName == null ? null : String(record.buildingName),
          floorName: record.floorName == null ? null : String(record.floorName),
          lastSeenAt: record.lastSeenAt ?? record.timestamp,
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

      // TagLatest is the live read model used by /api/db-tags and TagMonitor.
      // Update it from the same sampled records as history. This keeps the
      // latest timestamp fresh without writing a MongoDB document for every
      // raw socket packet.
      await TagLatest.bulkWrite(
        documents.map((document) => ({
          updateOne: {
            filter: { tagId: document.tagId },
            update: {
              $set: {
                tagId: document.tagId,
                placeId: document.placeId,
                buildingId: document.buildingId,
                floorId: document.floorId,
                zoneId: document.zoneId,
                zoneName: document.zoneName,
                groupId: document.groupId,
                groupName: document.groupName,
                tagName: document.tagName,
                firstName: document.firstName,
                lastName: document.lastName,
                uiDisplay: document.uiDisplay,
                tagType: document.tagType,
                batteryLevel: document.batteryLevel,
                placeName: document.placeName,
                buildingName: document.buildingName,
                floorName: document.floorName,
                lastSeenAt: document.lastSeenAt,
                status: "ALIVE",
                movementStatus: document.movementStatus,
                isAsset: false,
                x: document.x,
                y: document.y,
                z: document.z,
                timestamp: document.timestamp,
                receivedAt: document.receivedAt,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      try {
        const inserted = await TagEvent.insertMany(documents, { ordered: false });
        savedEventCount += inserted.length;
        log(`HISTORY/LATEST SAVED count=${inserted.length}`);
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

function parseSocketPayload(payload) {
  if (typeof payload !== "string") return payload;

  const text = payload.trim();
  if (!text) return payload;

  try {
    return JSON.parse(text);
  } catch {
    return payload;
  }
}

function handleTagPayload(payload, eventName = lastSocketEvent) {
  // Socket.IO deployments can deliver the actual location envelope as a JSON
  // string (not a JavaScript object). The old collector treated that string as
  // a non-object and therefore returned zero records. Parse it before applying
  // the same tolerant envelope walker used by the browser.
  const parsedPayload = parseSocketPayload(payload);
  const filteredPayload = filterAssetPayload(parsedPayload);
  if (filteredPayload === undefined) return;

  const records = collectLocationRecords(filteredPayload);
  log(`PAYLOAD event=${eventName} records=${records.length}`);

  if (records.length) {
    log(
      "POSITION DATA",
      records.slice(0, 20).map((record) => ({
        tagId: record.tagId,
        buildingId: record.buildingId,
        floorId: record.floorId,
        x: record.x,
        y: record.y,
        z: record.z,
        timestamp: record.timestamp?.toISOString?.() ?? record.timestamp,
      })),
    );
  } else {
    log("POSITION DATA EMPTY", {
      event: eventName,
      payloadType: typeof parsedPayload,
      payloadKeys: asObject(parsedPayload) ? Object.keys(parsedPayload).slice(0, 30) : [],
    });
  }

  if (!records.length) {
    // Keep a compact payload sample visible when UNAI changes its envelope.
    log("PAYLOAD SAMPLE", JSON.stringify(payload).slice(0, 3000));
    return;
  }

  lastMessageAt = Date.now();
  lastTagMessageAt = lastMessageAt;

  // Forward normalized records to local backend subscribers before history
  // sampling. The frontend receives the same single upstream stream and does
  // not need its own UNAI token/socket.
  for (const listener of realtimeListeners) {
    try {
      listener(records);
    } catch (error) {
      log("REALTIME LISTENER ERROR:", error?.message || error);
    }
  }

  // Anomaly detection runs on every normalized non-asset socket record,
  // independently from history sampling. This means a fast jump is still
  // detected even when TagEvent intentionally skips that history point.
  void Promise.all(
    records.map((record) =>
      evaluateRecord(record).catch((error) => {
        log("ANOMALY DETECTION ERROR:", error?.message || error);
      }),
    ),
  );

  enqueueHistorySave(records);
}

function buildInitLocationPayload(topic) {
  return {
    action: "get_init_unai_location",
    customId: "backend_history_collector",
    socketGetInitId: socket?.id || null,
    getMode: "only",
    get_topic: topic.encryptTopic,
    get_floor: String(topic.floorId),
  };
}

function broadcastToRoom(room, data) {
  if (!socket?.connected) return;
  socket.emit("/broadcastToRoom", {
    room,
    data,
    option: {},
  });
}

function sendInitLocationRequest(topic) {
  if (!socket?.connected) return;

  const payload = buildInitLocationPayload(topic);
  broadcastToRoom("init_unai_location", payload);

  log("INIT REQUEST SENT", {
    floorId: topic.floorId,
    encryptTopic: topic.encryptTopic,
    socketGetInitId: payload.socketGetInitId,
  });
}

function subscribeInitTopics(topic) {
  if (!socket?.connected) return;

  // `/join` is asynchronous. Wait for both joinedRoom acknowledgements before
  // broadcasting the init request; otherwise the request can race room setup.
  const topicKey = `${topic.floorId}:${topic.buildingId ?? ""}:${topic.placeId ?? ""}`;
  pendingInitRoomJoins.set(topicKey, {
    topic,
    joined: new Set(),
    requestSent: false,
  });

  socket.emit("/join", "init_unai_location_tag");
  socket.emit("/join", "init_unai_location_anchor");

  log("INIT ROOMS JOIN REQUESTED", {
    floorId: topic.floorId,
    topicKey,
    requiredRooms: ["init_unai_location_tag", "init_unai_location_anchor"],
  });
}

function inferInitLocationContext(payload) {
  const parsedPayload = parseSocketPayload(payload);
  if (!parsedPayload || typeof parsedPayload !== "object") return null;

  // UNAI init responses are keyed maps. The individual records carry the
  // authoritative floor/building/place and plaintext topic, while the root
  // object has only device/tag ids as keys. Keep all three ids so a reused
  // floor id in another building cannot select the wrong encrypted topic.
  const queue = [parsedPayload];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    const floorId = floorIdOf(current);
    const buildingId = buildingIdOf(current);
    const placeId = firstValue(current, ["placeId", "place_id", "placeID"]);
    const topic = firstValue(current, ["topic"]);

    if (floorId !== null || buildingId !== null || placeId !== undefined || topic !== undefined) {
      return {
        floorId,
        buildingId: buildingId === null ? null : String(buildingId),
        placeId: placeId === undefined ? null : String(placeId),
        topic: topic === undefined ? null : String(topic),
      };
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }

  return null;
}

function acknowledgeInitTopic(eventName, payload) {
  if (!socket?.connected) return;
  if (eventName !== "init_unai_location_tag" && eventName !== "init_unai_location_anchor") return;

  // Some UNAI deployments send the init response as JSON text. Normalize it
  // before checking/spreading fields; otherwise the handshake silently stops
  // here and the encrypted live rooms are never joined.
  const parsedPayload = parseSocketPayload(payload);
  if (!parsedPayload || typeof parsedPayload !== "object") return;

  const isTag = eventName === "init_unai_location_tag";
  const receivedRoom = isTag
    ? "init_unai_location_tag_received"
    : "init_unai_location_anchor_received";

  // The init response is DATA, not the acknowledgement envelope. It may be a
  // keyed object or an array depending on the UNAI gateway version. Never echo
  // that response back to the *_received room: the protocol requires the
  // original get_init_unai_location request fields to be acknowledged.
  const context = inferInitLocationContext(parsedPayload);
  // A valid UNAI floor can legitimately return an empty tag map (for example
  // when no tag is currently initialized on that floor). In that case the
  // empty object contains no floor/building/place metadata, but it still must
  // receive the protocol ACK or the anchor response can never complete the
  // two-event handshake. Use the topic that was used for the outstanding init
  // request as the authoritative fallback.
  const fallbackTopic = currentTopics[initTopicIndex] || null;
  const floorId = context?.floorId ?? fallbackTopic?.floorId ?? null;
  const buildingId = context?.buildingId ?? fallbackTopic?.buildingId ?? null;
  const placeId = context?.placeId ?? fallbackTopic?.placeId ?? null;
  const topic = currentTopics.find((item) => {
    if (String(item.floorId) !== String(floorId)) return false;
    if (buildingId !== null && item.buildingId !== null && String(item.buildingId) !== String(buildingId)) return false;
    if (placeId !== null && item.placeId !== null && String(item.placeId) !== String(placeId)) return false;
    return true;
  });

  if (!topic) {
    log("INIT ACK TOPIC NOT RESOLVED", {
      eventName,
      floorId,
      buildingId,
      placeId,
      responseTopic: context?.topic ?? fallbackTopic?.topic ?? null,
      fallbackTopic: fallbackTopic
        ? {
            floorId: fallbackTopic.floorId,
            buildingId: fallbackTopic.buildingId,
            placeId: fallbackTopic.placeId,
            encryptTopic: fallbackTopic.encryptTopic,
          }
        : null,
      candidates: currentTopics
        .filter((item) => String(item.floorId) === String(floorId))
        .map((item) => ({
          floorId: item.floorId,
          buildingId: item.buildingId,
          placeId: item.placeId,
          encryptTopic: item.encryptTopic,
        }))
        .slice(0, 20),
      payloadKeys: Object.keys(parsedPayload).slice(0, 30),
    });
    return;
  }

  const acknowledgement = {
    action: receivedRoom,
    customId: "backend_history_collector",
    socketGetInitId: socket.id,
    getMode: "only",
    get_topic: topic.encryptTopic,
    get_floor: String(topic.floorId),
  };

  // The official protocol joins the *_received room only after the initial
  // init response arrives, then broadcasts the exact acknowledgement envelope.
  socket.emit("/join", receivedRoom);
  broadcastToRoom(receivedRoom, acknowledgement);

  const encryptedTagTopic = `unai/${topic.encryptTopic}/tag`;
  const encryptedAnchorTopic = `unai/${topic.encryptTopic}/anchor`;
  socket.emit("/join", encryptedTagTopic);
  socket.emit("/join", encryptedAnchorTopic);
  log("LIVE ROOMS JOINED", {
    floorId: topic.floorId,
    buildingId: topic.buildingId,
    placeId: topic.placeId,
    responseTopic: context?.topic ?? null,
    eventName,
    encryptedTagTopic,
    encryptedAnchorTopic,
  });

  const topicKey = `${topic.floorId}:${topic.buildingId ?? ""}:${topic.placeId ?? ""}`;
  const acknowledged = initAckedEvents.get(topicKey) || new Set();
  acknowledged.add(eventName);
  initAckedEvents.set(topicKey, acknowledged);

  if (
    acknowledged.has("init_unai_location_tag") &&
    acknowledged.has("init_unai_location_anchor")
  ) {
    const completedIndex = currentTopics.findIndex(
      (item) => `${item.floorId}:${item.buildingId ?? ""}:${item.placeId ?? ""}` === topicKey,
    );
    if (completedIndex === initTopicIndex && completedIndex + 1 < currentTopics.length) {
      initTopicIndex = completedIndex + 1;
      subscribeInitTopics(currentTopics[initTopicIndex]);
      log("INIT TOPIC ADVANCED", {
        completedFloorId: topic.floorId,
        nextFloorId: currentTopics[initTopicIndex].floorId,
        nextIndex: initTopicIndex,
        totalTopics: currentTopics.length,
      });
    }
  }

  log("INIT ACK SENT", {
    eventName,
    receivedRoom,
    floorId,
    buildingId,
    placeId,
  });
}

function subscribeTopic(topic) {
  // Do not join the live encrypted rooms before the init handshake completes.
  // UNAI documents the order as init request -> init response -> *_received
  // acknowledgement -> encrypted tag/anchor room.
  subscribeInitTopics(topic);

  if (!topicFallbackTimer) {
    topicFallbackTimer = setTimeout(() => {
      topicFallbackTimer = null;
      if (!started || !socket?.connected || lastTagMessageAt) return;

      // Some UNAI gateway instances acknowledge `/join` asynchronously. Give
      // the *_received room a chance to become active, then repeat the exact
      // encrypted-room subscription once. This is deliberately bounded to one
      // retry so a dead upstream cannot turn into a reconnect/rate-limit loop.
      const currentTopic = currentTopics[initTopicIndex];
      if (!currentTopic) return;

      log("No clientBox/tag location after init handshake; retrying current encrypted live rooms once", {
        floorId: currentTopic.floorId,
        index: initTopicIndex,
      });
      const encryptedTagTopic = `unai/${currentTopic.encryptTopic}/tag`;
      const encryptedAnchorTopic = `unai/${currentTopic.encryptTopic}/anchor`;
      socket?.emit("/join", encryptedTagTopic);
      socket?.emit("/join", encryptedAnchorTopic);

      setTimeout(() => {
        if (!started || !socket?.connected || lastTagMessageAt) return;
        log("No live clientBox after encrypted-room retry", {
          topics: currentTopics.length,
          lastSocketEvent,
        });
      }, 5_000);
    }, 10_000);
  }
}

/*
function buildInitLocationPayload(topic) {
  return {
    action: "get_init_unai_location",
    customId: "backend_history_collector",
    socketGetInitId: socket?.id || null,
    getMode: "only",
    get_topic: topic.encryptTopic,
    get_floor: String(topic.floorId),
  };
}

function broadcastToRoom(room, data) {
  if (!socket?.connected) return;
  socket.emit("/broadcastToRoom", {
    room,
    data,
    option: {},
  });
}

function subscribeInitTopics(topic) {
  if (!socket?.connected) return;

  // UNAI protocol: join init rooms -> request init data -> receive init
  // response -> join *_received room -> broadcast acknowledgement -> join the
  // encrypted tag/anchor rooms. Joining *_received before the response is too
  // early and can leave the server without the expected initialization state.
  socket.emit("/join", "init_unai_location_tag");
  socket.emit("/join", "init_unai_location_anchor");

  const payload = buildInitLocationPayload(topic);
  broadcastToRoom("init_unai_location", payload);

  log("INIT REQUEST SENT", {
    floorId: topic.floorId,
    encryptTopic: topic.encryptTopic,
    socketGetInitId: payload.socketGetInitId,
  });
}

function acknowledgeInitTopic(eventName, payload) {
  if (!socket?.connected) return;
  if (eventName !== "init_unai_location_tag" && eventName !== "init_unai_location_anchor") return;

  const parsedPayload = parseSocketPayload(payload);
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) return;

  const isTag = eventName === "init_unai_location_tag";
  const receivedRoom = isTag
    ? "init_unai_location_tag_received"
    : "init_unai_location_anchor_received";
  const acknowledgement = {
    ...parsedPayload,
    action: receivedRoom,
    customId: "backend_history_collector",
    socketGetInitId: socket.id,
  };

  socket.emit("/join", receivedRoom);
  broadcastToRoom(receivedRoom, acknowledgement);

  const floorId = firstValue(parsedPayload, ["get_floor", "floorId", "floor_id", "floor"]);
  const topic = currentTopics.find((item) => String(item.floorId) === String(floorId));
  if (topic) {
    const encryptedTagTopic = `unai/${topic.encryptTopic}/tag`;
    const encryptedAnchorTopic = `unai/${topic.encryptTopic}/anchor`;
    socket.emit("/join", encryptedTagTopic);
    socket.emit("/join", encryptedAnchorTopic);
    log("LIVE ROOMS JOINED", {
      floorId: topic.floorId,
      eventName,
      encryptedTagTopic,
      encryptedAnchorTopic,
    });
  } else {
    log("INIT ACK FLOOR NOT RESOLVED", {
      eventName,
      floorId,
      payloadKeys: Object.keys(parsedPayload).slice(0, 30),
    });
  }

  log("INIT ACK SENT", { eventName, receivedRoom, floorId });
}

*/

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
      if (Number(error?.status) === 429 || isRateLimitError(error)) {
        const retryAfter = Number(error?.retryAfterMs);
        cooldownUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, RATE_LIMIT_COOLDOWN_MS)
          : RATE_LIMIT_COOLDOWN_MS);
        throw error;
      }
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
    log("No socket_token available; scheduling topic generation retry");
    if (configuredFloors.length) scheduleReconnect("waiting_for_token", 5_000);
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
    // Keep the original direct-WebSocket transport. Do not probe polling
    // first because the RTLS Socket endpoint is intended to be consumed as a
    // WebSocket stream and an unnecessary failed transport attempt can count
    // toward the upstream connection-attempt limiter.
    transports: ["websocket"],
    upgrade: false,
    secure: true,
    reconnection: false,
    forceNew: true,
    timeout: 10_000,
    autoConnect: false,
  });

  // Critical diagnostic: do not guess UNAI's event envelope. This shows the
  // actual event names emitted by the upstream Socket.IO server.
  socket.on("joinedRoom", (payload) => {
    const parsedPayload = parseSocketPayload(payload);
    log("JOINED ROOM ACK", {
      payloadType: typeof parsedPayload,
      payload: parsedPayload,
      socketId: socket?.id || null,
    });

    const room = asObject(parsedPayload)?.room;
    if (typeof room !== "string") return;
    if (room !== "init_unai_location_tag" && room !== "init_unai_location_anchor") return;

    for (const [topicKey, pending] of pendingInitRoomJoins.entries()) {
      if (!pending || pending.requestSent) continue;

      pending.joined.add(room);
      log("INIT ROOM JOIN CONFIRMED", {
        floorId: pending.topic.floorId,
        room,
        joinedCount: pending.joined.size,
        requiredCount: 2,
      });

      if (
        pending.joined.has("init_unai_location_tag") &&
        pending.joined.has("init_unai_location_anchor")
      ) {
        pending.requestSent = true;
        pendingInitRoomJoins.set(topicKey, pending);
        sendInitLocationRequest(pending.topic);
      }
    }
  });

  socket.onAny((event, ...args) => {
    lastSocketEvent = event;
    log("SOCKET EVENT", event, {
      argCount: args.length,
      args: args.map((value, index) => ({
        index,
        type: typeof value,
        keys: asObject(value) ? Object.keys(value).slice(0, 30) : [],
        preview: typeof value === "string" ? value.slice(0, 1000) : value,
      })),
    });
    log("SOCKET PING/PONG TRACE", {
      event,
      socketId: socket?.id || null,
      connected: Boolean(socket?.connected),
      argCount: args.length,
      at: new Date().toISOString(),
    });

      // UNAI deployments do not always use the same event name for the tag
    // stream. Do not restrict the collector to clientBox/tag/message: inspect
    // every application event and let collectLocationRecords decide whether
    // its payload actually contains a tag position. Lifecycle events are
    // ignored to avoid treating connection metadata as location data.
    if (
      event === "connect" ||
      event === "disconnect" ||
      event === "connect_error" ||
      event === "clientBox"
    ) return;
    args.forEach((payload) => handleTagPayload(payload, event));
  });

  socket.on("connect", () => {
    reconnectAttempt = 0;
    cooldownUntil = 0;
    lastConnectedAt = Date.now();
    lastMessageAt = 0;
    lastTagMessageAt = 0;
    lastError = null;
    setState("CONNECTED");
    log(`CONNECTED socketId=${socket.id}`);

    // Keep register for deployments that expose it; the UNAI realtime protocol
    // then requires the init handshake before encrypted tag rooms emit clientBox.
    socket.emit("/register", { customId: "backend_history_collector" });

    // UNAI's documented realtime location transport emits the live tag/anchor
    // stream through the `clientBox` application event. Keep an explicit
    // listener in addition to the catch-all diagnostic listener so we can prove
    // that the actual live packet reaches this process and normalize it exactly
    // once. This is especially important because the current runtime had a
    // successful socket/join handshake but no observed clientBox event.
    socket.on("clientBox", (payload) => {
      lastSocketEvent = "clientBox";
      const parsedPayload = parseSocketPayload(payload);
      log("CLIENTBOX RECEIVED", {
        payloadType: typeof parsedPayload,
        payloadKeys: asObject(parsedPayload) ? Object.keys(parsedPayload).slice(0, 30) : [],
        payloadPreview: typeof parsedPayload === "string"
          ? parsedPayload.slice(0, 2000)
          : JSON.stringify(parsedPayload).slice(0, 3000),
      });
      handleTagPayload(payload, "clientBox");
    });

    socket.on("init_unai_location_tag", (payload) => {
      log("INIT TAG RESPONSE", {
        payloadType: typeof payload,
        payloadKeys: asObject(payload) ? Object.keys(payload).slice(0, 30) : [],
      });
      acknowledgeInitTopic("init_unai_location_tag", payload);
    });
    socket.on("init_unai_location_anchor", (payload) => {
      log("INIT ANCHOR RESPONSE", {
        payloadType: typeof payload,
        payloadKeys: asObject(payload) ? Object.keys(payload).slice(0, 30) : [],
      });
      acknowledgeInitTopic("init_unai_location_anchor", payload);
    });
    initTopicIndex = 0;
    initAckedEvents.clear();
    pendingInitRoomJoins.clear();
    if (currentTopics.length) subscribeTopic(currentTopics[0]);
  });

  socket.on("connect_error", async (error) => {
    lastError = error?.message || String(error);
    log("CONNECT ERROR:", lastError);
    log("CONNECT ERROR DETAILS", {
      description: error?.description || null,
      context: error?.context ? String(error.context).slice(0, 1000) : null,
      transport: socket?.io?.engine?.transport?.name || null,
      url: SOCKET_URL,
      path: SOCKET_PATH,
    });

    if (isRateLimitError(error)) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      closeSocket();
      scheduleReconnect("rate_limit");
      return;
    }

    // 502/503/504 means the WebSocket gateway/upstream is unavailable.
    // Do NOT regenerate socket credentials here: the handshake already sent
    // the cached socket_token, and an upstream failure does not prove that the
    // token is invalid. Repeated immediate retries only add load to a failing
    // gateway and can trigger the UNAI connection-attempt limiter.
    if (isUpstreamUnavailableError(error)) {
      const status = getSocketHttpStatus(error);
      lastError = `UNAI socket upstream unavailable: HTTP ${status}`;
      log(
        `UPSTREAM UNAVAILABLE HTTP ${status}; keeping cached socket credentials`,
      );
      closeSocket();
      scheduleReconnect(
        "upstream_unavailable",
        UPSTREAM_UNAVAILABLE_BACKOFF_MS,
      );
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

  // `socket.onAny` above is the single application-event ingestion path.
  // Keeping separate clientBox/tag/message listeners would process those
  // packets twice and could duplicate SSE notifications/logging.

  // Start only after every diagnostic/error listener has been attached.
  socket.connect();
}

async function refreshTopics(floors = []) {
  const list = Array.isArray(floors) ? floors : [];
  // Preserve the floor configuration across rate-limit failures.
  if (list.length) configuredFloors = list.map((floor) => ({ ...floor }));

  const results = [];
  for (const floor of list) {
    const floorId = firstValue(floor, ["id", "floorId", "floor_id", "floorID"]);
    if (floorId === undefined) continue;

    try {
      // The UNAI encrypted topic is floor-specific. generateSocketTopic() is
      // already cached per floor for 29 days, so this does not create repeated
      // requests during normal reconnects, while preventing floor 1 credentials
      // from being incorrectly reused for every floor.
      const result = await generateSocketTopic(floorId);
      results.push({
        floorId,
        buildingId: firstValue(floor, ["buildingId", "building_id", "buildingID"]),
        placeId: firstValue(floor, ["placeId", "place_id", "placeID"]),
        socket_token: result.socket_token,
        encrypt_topic: result.encrypt_topic,
      });
      log("TOPIC READY", { floorId: String(floorId), hasEncryptTopic: Boolean(result.encrypt_topic) });
    } catch (error) {
      log(`Topic generation failed floor=${floorId}:`, error?.message || error);
      if (Number(error?.status) === 429 || isRateLimitError(error)) {
        const retryAfter = Number(error?.retryAfterMs);
        cooldownUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, RATE_LIMIT_COOLDOWN_MS)
          : RATE_LIMIT_COOLDOWN_MS);
        setState("RATE_LIMITED");
        throw error;
      }
    }
  }

  currentTopics = normalizeTopics(results);
  log(`TOPICS loaded=${currentTopics.length}`);
  return currentTopics;
}

async function start(options = {}) {
  if (started) return getStatus();

  started = true;
  configuredFloors = Array.isArray(options.floors)
    ? options.floors.map((floor) => ({ ...floor }))
    : [];
  setState("STARTING");
  startHealthMonitor();

  try {
    await refreshTopics(configuredFloors);

    if (!currentTopics.length) {
      setState("WAITING_FOR_TOPICS");
      log("No valid floor topics; collector will not create a socket connection");
      return getStatus();
    }

    await connect();
  } catch (error) {
    lastError = error?.message || String(error);
    log("START ERROR:", lastError);

    if (Number(error?.status) === 429 || isRateLimitError(error)) {
      const retryAfter = Number(error?.retryAfterMs);
      const delay = Math.max(
        1_000,
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, RATE_LIMIT_COOLDOWN_MS)
          : Math.max(1_000, cooldownUntil - Date.now()),
      );
      cooldownUntil = Date.now() + delay;
      scheduleReconnect("rate_limit", delay);
    } else {
      scheduleReconnect("start_error");
    }
  }

  return getStatus();
}

function stop() {
  started = false;
  clearReconnectTimer();
  clearTopicFallbackTimer();
  clearHealthTimer();
  cooldownUntil = 0;
  reconnectAttempt = 0;
  closeSocket();
  currentTopics = [];
  configuredFloors = [];
  initTopicIndex = 0;
  initAckedEvents.clear();
  pendingInitRoomJoins.clear();
  lastSavedPositions.clear();
  setState("STOPPED");
}

function subscribeRealtime(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("realtime listener must be a function");
  }

  realtimeListeners.add(listener);
  return () => realtimeListeners.delete(listener);
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
    lastMessageAt: lastTagMessageAt || lastMessageAt || null,
    lastTagMessageAt: lastTagMessageAt || null,
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
  subscribeRealtime,
  getStatus,
};
