const { io } = require("socket.io-client");
const { generateSocketTopic } = require("./unaiApi");
const TagEvent = require("../models/TagEvent");
const { getAssetTagIds, isAssetOrKnownAsset } = require("./assetFilter");

let socket = null;
let started = false;
let state = "STOPPED";
let reconnectTimer = null;
let reconnectAttempt = 0;
let cooldownUntil = 0;
let currentTopics = [];
const lastSavedPositions = new Map();
let saveQueue = Promise.resolve();

const SOCKET_URL = process.env.UNAI_SOCKET_URL || "https://socket.lailab.online";
const SOCKET_PATH = process.env.UNAI_SOCKET_PATH || "/ble/location";
const MAX_BACKOFF_MS = 60_000;

function log(...args) {
  console.log("[UNAI SOCKET]", ...args);
}

function setState(next) {
  state = next;
  log(`STATE=${next}`);
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => ({
      floorId: Number(t.floorId ?? t.floor_id ?? t.id),
      buildingId: Number(t.buildingId ?? t.building_id),
      encryptTopic: t.encryptTopic ?? t.encrypt_topic ?? t.topic,
      socketToken: t.socketToken ?? t.socket_token,
    }))
    .filter((t) => Number.isFinite(t.floorId) && t.encryptTopic);
}

function extractSocketToken(topics) {
  return topics.find((t) => t.socketToken)?.socketToken || null;
}

function backoffDelay() {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** reconnectAttempt);
  const jitter = Math.floor(Math.random() * Math.max(250, base * 0.25));
  reconnectAttempt += 1;
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

function scheduleReconnect(reason) {
  if (!started || reconnectTimer) return;
  const delay = reason === "rate_limit" ? Math.max(30_000, cooldownUntil - Date.now()) : backoffDelay();
  setState(reason === "rate_limit" ? "RATE_LIMITED" : "BACKOFF");
  log(`Reconnect scheduled in ${delay}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function closeSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function isRateLimitError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("rate") || text.includes("too many") || text.includes("limit");
}

function isAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usageType = value.usage_type ?? value.usageType ?? value.usage?.type;
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function filterAssetPayload(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => !isAsset(item)).map(filterAssetPayload);
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

function numberValue(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function timestampValue(value) {
  if (typeof value === "number") { const date = new Date(value < 100000000000 ? value * 1000 : value); if (!Number.isNaN(date.getTime())) return date; }
  if (typeof value === "string" && value.trim()) { const date = new Date(value); if (!Number.isNaN(date.getTime())) return date; }
  return new Date();
}

function collectLocationRecords(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) { value.forEach((item) => collectLocationRecords(item, output)); return output; }
  const object = value;
  const tagId = object.tagId ?? object.tag_id ?? object.tagID ?? object.tag?.id ?? object.tag?.tagId ?? object.tag?.tag_id;
  const x = numberValue(object.x ?? object.pos_x ?? object.position_x ?? object.location_x);
  const y = numberValue(object.y ?? object.pos_y ?? object.position_y ?? object.location_y);
  if (tagId !== undefined && tagId !== null && x !== null && y !== null) {
    output.push({ ...object, tagId: String(tagId), x, y, z: numberValue(object.z ?? object.pos_z ?? object.position_z ?? object.location_z), timestamp: timestampValue(object.timestamp ?? object.time ?? object.unix_time ?? object.unixTime ?? object.lastSeenAt ?? object.date_now ?? object.created_at) });
  }
  Object.values(object).forEach((child) => { if (child && typeof child === "object") collectLocationRecords(child, output); });
  return output;
}

function enqueueHistorySave(records, topic) {
  if (!records.length) return;
  saveQueue = saveQueue.then(async () => {
    const assetTagIds = await getAssetTagIds();
    const documents = [];
    const now = Date.now();
    for (const record of records) {
      if (isAssetOrKnownAsset(record, assetTagIds) || assetTagIds.has(String(record.tagId))) continue;
      const key = String(record.tagId);
      const previous = lastSavedPositions.get(key);
      const positionChanged = !previous || previous.x !== record.x || previous.y !== record.y || previous.floorId !== String(topic.floorId);
      const enoughTimePassed = !previous || now - previous.savedAt >= 2000;
      if (!positionChanged && !enoughTimePassed) continue;
      documents.push({ tagId: key, buildingId: topic.buildingId == null ? null : String(topic.buildingId), floorId: topic.floorId == null ? null : String(topic.floorId), groupId: record.groupId ?? record.group_id ?? null, groupName: record.groupName ?? record.group_name ?? null, tagName: record.tagName ?? record.tag_name ?? record.name ?? record.label ?? null, event: "position_update", status: "ALIVE", movementStatus: positionChanged ? "MOVING" : "STATIONARY", x: record.x, y: record.y, z: record.z, timestamp: record.timestamp, rawData: record });
      lastSavedPositions.set(key, { x: record.x, y: record.y, floorId: String(topic.floorId), savedAt: now });
    }
    if (!documents.length) return;
    await TagEvent.insertMany(documents, { ordered: false });
    log(`HISTORY SAVED count=${documents.length} floor=${topic.floorId}`);
  }).catch((error) => log("HISTORY SAVE ERROR:", error?.message || error));
}

function handleTagPayload(payload, topic) {
  // This backend socket manager is another possible logging boundary. Never
  // print or forward an object whose usage_type is ASSET.
  const filteredPayload = filterAssetPayload(payload);
  if (filteredPayload === undefined) return;
  if (Array.isArray(filteredPayload) && filteredPayload.length === 0) return;

  const records = collectLocationRecords(filteredPayload);
  enqueueHistorySave(records, topic);

  log("TAG UPDATE", {
    floorId: topic.floorId,
    buildingId: topic.buildingId,
    count: records.length,
  });
}

function subscribeTopic(topic) {
  const tagTopic = `unai/${topic.encryptTopic}/tag`;
  const anchorTopic = `unai/${topic.encryptTopic}/anchor`;

  socket.emit("/join", tagTopic);
  socket.emit("/join", anchorTopic);
  socket.emit("init_unai_location_tag", { topic: topic.encryptTopic });
  socket.emit("init_unai_location_anchor", { topic: topic.encryptTopic });

  // Some UNAI deployments emit clientBox globally after topic initialization.
  log(`Subscribed floor=${topic.floorId} topic=${tagTopic}`);
}

function connect() {
  if (!started) return;
  if (Date.now() < cooldownUntil) {
    scheduleReconnect("rate_limit");
    return;
  }
  if (socket && (socket.connected || socket.connecting)) return;

  const token = extractSocketToken(currentTopics);
  if (!token) {
    setState("WAITING_FOR_TOKEN");
    log("No socket token available; waiting for topic/token generation");
    return;
  }

  closeSocket();
  setState("CONNECTING");
  log(`Connecting to ${SOCKET_URL}${SOCKET_PATH}`);

  socket = io(SOCKET_URL, {
    path: SOCKET_PATH,
    transports: ["websocket"],
    query: { token },
    auth: { token, socket_token: token },
    reconnection: false,
    forceNew: false,
    timeout: 10_000,
  });

  socket.on("connect", () => {
    reconnectAttempt = 0;
    cooldownUntil = 0;
    setState("CONNECTED");
    log(`Connected id=${socket.id}`);
    socket.emit("/register", { customId: "backend_history_collector" });
    currentTopics.forEach(subscribeTopic);
  });

  socket.on("connect_error", (err) => {
    log("CONNECT ERROR:", err?.message || err);
    if (isRateLimitError(err)) {
      cooldownUntil = Date.now() + 60_000;
      closeSocket();
      scheduleReconnect("rate_limit");
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

  socket.on("clientBox", (payload) => {
    currentTopics.forEach((topic) => handleTagPayload(payload, topic));
  });
  socket.on("tag", (payload) => {
    currentTopics.forEach((topic) => handleTagPayload(payload, topic));
  });
  socket.on("message", (payload) => {
    currentTopics.forEach((topic) => handleTagPayload(payload, topic));
  });
  socket.on("init_unai_location_tag", (payload) => {
    log("INITIAL TAG DATA", payload);
  });
  socket.on("init_unai_location_tag_received", (payload) => {
    log("INITIAL TAG DATA RECEIVED", payload);
  });
}

async function refreshTopics(floors = []) {
  const list = Array.isArray(floors) ? floors : [];
  const results = [];
  for (const floor of list) {
    try {
      const result = await generateSocketTopic(floor.id ?? floor.floorId ?? floor.floor_id);
      const values = Array.isArray(result) ? result : [result];
      values.forEach((value) => {
        results.push({
          floorId: floor.id ?? floor.floorId ?? floor.floor_id,
          buildingId: floor.buildingId ?? floor.building_id,
          ...(value || {}),
        });
      });
    } catch (err) {
      log(`Topic generation failed floor=${floor.id ?? floor.floorId}:`, err?.message || err);
    }
  }
  currentTopics = normalizeTopics(results);
  log(`Loaded ${currentTopics.length} socket topic(s)`);
  return currentTopics;
}

async function start(options = {}) {
  if (started) return;
  started = true;
  setState("STARTING");
  try {
    await refreshTopics(options.floors || []);
    connect();
  } catch (err) {
    log("START ERROR:", err?.message || err);
    scheduleReconnect("start_error");
  }
}

function stop() {
  started = false;
  lastSavedPositions.clear();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  cooldownUntil = 0;
  closeSocket();
  setState("STOPPED");
}

function getStatus() {
  return {
    started,
    state,
    connected: Boolean(socket?.connected),
    socketId: socket?.id || null,
    reconnectAttempt,
    cooldownUntil: cooldownUntil || null,
    topicCount: currentTopics.length,
  };
}

module.exports = {
  start,
  stop,
  connect,
  refreshTopics,
  getStatus,
};
