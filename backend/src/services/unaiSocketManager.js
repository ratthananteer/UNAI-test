// CENTRAL UNAI RTLS SOCKET MANAGER
// One long-lived Socket.IO connection is owned by the backend process.
// Frontend pages must not connect directly to socket.lailab.online.
//
// Connection policy:
// - reuse one connection for all floors
// - exponential backoff + jitter for network failures
// - stop and cool down on UNAI rate limiting
// - refresh the access token once on authentication rejection
// - save normalized tag positions directly to MongoDB
// - deduplicate identical positions to avoid unnecessary TagEvent writes

const { io } = require("socket.io-client");
const TagEvent = require("../models/TagEvent");
const { getAccessToken, refreshAccessToken } = require("./unaiAuth");
const StaticData = require("../models/StaticData");
const { fetchFromApi } = require("./unaiApi");

const SOCKET_URL = process.env.UNAI_SOCKET_URL || "https://socket.lailab.online";
const SOCKET_PATH = process.env.UNAI_SOCKET_PATH || "/ble/location";
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.UNAI_SOCKET_RATE_LIMIT_COOLDOWN_MS) || 60_000;
const EVENT_DEDUP_MS = Number(process.env.UNAI_TAG_EVENT_DEDUP_MS) || 1000;

let socket = null;
let state = "DISCONNECTED";
let retryTimer = null;
let rateLimitUntil = 0;
let retryAttempt = 0;
let tokenRefreshAttempted = false;
const joinedRooms = new Set();
const lastSaved = new Map();

function log(message, ...args) {
  console.log(`[UNAI SOCKET] ${message}`, ...args);
}

function setState(next) {
  if (state !== next) {
    state = next;
    log(`STATE=${next}`);
  }
}

function isRateLimitError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("too many connection attempts") || text.includes("rate limit") || text.includes("rate-limit") || error?.data?.code === 429;
}

function backoffDelay(attempt) {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  return Math.floor(exponential * (0.75 + Math.random() * 0.5));
}

function scheduleReconnect(reason) {
  if (retryTimer || state === "RATE_LIMITED") return;

  const delay = backoffDelay(retryAttempt++);
  setState("BACKOFF");
  log(`Reconnect scheduled in ${delay}ms: ${reason}`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function scheduleRateLimitCooldown(message) {
  rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  setState("RATE_LIMITED");
  log(`${message}. No connection attempt for ${RATE_LIMIT_COOLDOWN_MS}ms.`);

  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  retryTimer = setTimeout(() => {
    retryTimer = null;
    rateLimitUntil = 0;
    retryAttempt = 0;
    setState("DISCONNECTED");
    connect();
  }, RATE_LIMIT_COOLDOWN_MS);
}

function normalizeEvents(payload, fallbackFloorId = null) {
  const objects = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    objects.push(value);
    const object = value;
    [object.data, object.item, object.result, object.payload, object.tag, object.tags, object.location, object.positions].forEach(visit);
  };
  visit(payload);

  const events = [];
  for (const object of objects) {
    const rawTagId = object.tagId ?? object.tag_id ?? object.tagID ?? object.id;
    const x = Number(object.x ?? object.pos_x ?? object.position_x ?? object.location_x);
    const y = Number(object.y ?? object.pos_y ?? object.position_y ?? object.location_y);
    if ((typeof rawTagId !== "string" && typeof rawTagId !== "number") || !Number.isFinite(x) || !Number.isFinite(y)) continue;

    const floorId = object.floorId ?? object.floor_id ?? object.floor ?? object.floorID ?? fallbackFloorId;
    const buildingId = object.buildingId ?? object.building_id ?? object.building ?? null;
    const timestampValue = object.timestamp ?? object.time ?? object.unix_time ?? object.unixTime ?? object.lastSeenAt ?? object.date_now;
    const timestamp = timestampValue == null ? new Date() : new Date(Number(timestampValue) < 100000000000 ? Number(timestampValue) * 1000 : timestampValue);

    events.push({
      tagId: String(rawTagId),
      buildingId: buildingId == null ? null : String(buildingId),
      floorId: floorId == null ? null : String(floorId),
      groupId: object.groupId ?? object.group_id ?? null,
      groupName: object.groupName ?? object.group_name ?? null,
      tagName: object.tagName ?? object.tag_name ?? object.name ?? object.label ?? null,
      event: "position_update",
      x,
      y,
      z: Number.isFinite(Number(object.z)) ? Number(object.z) : null,
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
      rawData: object,
    });
  }

  const unique = new Map();
  for (const event of events) {
    unique.set(`${event.tagId}:${event.floorId}:${event.x}:${event.y}`, event);
  }
  return [...unique.values()];
}

async function saveEvents(events) {
  if (!events.length) return;
  const now = Date.now();
  const toSave = [];

  for (const event of events) {
    const key = event.tagId;
    const previous = lastSaved.get(key);
    const currentTime = event.timestamp.getTime();

    // Store a new event when the tag moved, changed floor/building, or enough
    // time passed since the last identical position. This prevents a busy RTLS
    // stream from creating thousands of identical MongoDB documents.
    const changed = !previous || previous.x !== event.x || previous.y !== event.y || previous.floorId !== event.floorId || previous.buildingId !== event.buildingId;
    const heartbeatDue = !previous || now - previous.savedAt >= EVENT_DEDUP_MS;

    if (!changed && !heartbeatDue) continue;
    lastSaved.set(key, { ...event, savedAt: now, currentTime });
    toSave.push(event);
  }

  if (!toSave.length) return;

  try {
    await TagEvent.insertMany(toSave, { ordered: false });
    log(`Saved ${toSave.length} TagEvent(s)`);
  } catch (error) {
    console.error("[UNAI SOCKET] TagEvent save failed:", error.message);
  }
}

function handleTag(payload, floorId = null) {
  const events = normalizeEvents(payload, floorId);
  if (!events.length) return;
  void saveEvents(events);
}

async function joinConfiguredFloors() {
  if (!socket?.connected) return;

  let rows = await StaticData.find({ type: "floor" }).lean();
  if (!rows.length && process.env.APIFLOOR_URL) {
    try {
      const remote = await fetchFromApi(process.env.APIFLOOR_URL, "Failed to get floors");
      rows = (Array.isArray(remote) ? remote : []).map((data) => ({ data }));
    } catch (error) {
      console.error("[UNAI SOCKET] Could not load floors:", error.message);
    }
  }

  for (const row of rows) {
    const floor = row.data || row;
    const floorId = floor.id ?? floor.floor_id ?? floor.floorId;
    if (floorId == null) continue;
    const buildingId = floor.building_id ?? floor.buildingId ?? (floor.building && floor.building.id);
    const placeId = floor.place_id ?? floor.placeId ?? (floor.place && floor.place.id);
    joinFloor(floorId, placeId, buildingId);
  }

  log(`Floor subscription scan complete: ${rows.length} floor(s)`);
}

function joinFloor(floorId, placeId = null, buildingId = null) {
  if (!socket?.connected || floorId == null) return;
  const base = [placeId, buildingId, floorId].filter((v) => v != null).join("/");
  if (!base) return;

  const rooms = [`unai/${base}/tag`, `unai/${base}/anchor`, `unai/${base}/alert`];
  for (const room of rooms) {
    if (!joinedRooms.has(room)) {
      socket.emit("/join", room);
      joinedRooms.add(room);
      log(`Joined ${room}`);
    }
  }
}

function createSocket() {
  const token = process.env.ACCESS_TOKEN;
  if (!token) throw new Error("UNAI access token is not available");

  socket = io(SOCKET_URL, {
    path: SOCKET_PATH,
    query: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });

  socket.on("connect", () => {
    retryAttempt = 0;
    tokenRefreshAttempted = false;
    joinedRooms.clear();
    setState("CONNECTED");
    log(`Connected id=${socket.id}`);

    socket.emit("/register", { customId: "unai_backend_collector" });
    void joinConfiguredFloors();
  });

  socket.on("tag", (payload) => handleTag(payload));
  socket.on("clientBox", (payload) => handleTag(payload));
  socket.on("sensor", (payload) => handleTag(payload));
  socket.on("message", (payload) => handleTag(payload));

  socket.on("disconnect", (reason) => {
    log(`Disconnected: ${reason}`);
    socket = null;
    joinedRooms.clear();
    if (state !== "RATE_LIMITED") scheduleReconnect(reason);
  });

  socket.on("connect_error", async (error) => {
    const message = error?.message || String(error);
    console.error(`[UNAI SOCKET] connect_error: ${message}`);

    if (isRateLimitError(error)) {
      socket?.disconnect();
      socket = null;
      scheduleRateLimitCooldown("UNAI rate limit reached");
      return;
    }

    // An auth failure is the only case where a token refresh is appropriate.
    const authFailure = /unauthorized|forbidden|invalid.*token|authentication/i.test(message);
    if (authFailure && !tokenRefreshAttempted) {
      tokenRefreshAttempted = true;
      try {
        await refreshAccessToken();
        socket?.disconnect();
        socket = null;
        retryAttempt = 0;
        scheduleReconnect("access token refreshed");
        return;
      } catch (refreshError) {
        console.error("[UNAI SOCKET] Token refresh failed:", refreshError.message);
      }
    }

    socket?.disconnect();
    socket = null;
    scheduleReconnect(message);
  });
}

async function connect() {
  if (socket?.connected || state === "CONNECTING" || state === "BACKOFF") return;
  if (Date.now() < rateLimitUntil) return;

  try {
    setState("CONNECTING");
    await getAccessToken();
    createSocket();
  } catch (error) {
    console.error("[UNAI SOCKET] Setup failed:", error.message);
    scheduleReconnect(error.message);
  }
}

function start() {
  if (state !== "DISCONNECTED") return;
  log(`Starting collector: ${SOCKET_URL}${SOCKET_PATH}`);
  void connect();
}

function stop() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  rateLimitUntil = 0;
  joinedRooms.clear();
  socket?.disconnect();
  socket = null;
  setState("DISCONNECTED");
}

function getStatus() {
  return {
    state,
    connected: Boolean(socket?.connected),
    socketId: socket?.id || null,
    retryAttempt,
    rateLimited: Date.now() < rateLimitUntil,
    retryAt: rateLimitUntil || null,
  };
}

module.exports = {
  start,
  stop,
  connect,
  joinFloor,
  getStatus,
};
