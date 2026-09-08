const crypto = require("crypto");
const AnomalyEvent = require("../models/AnomalyEvent");
const { getCached } = require("./staticDataCache");

// RULE-BASED ANOMALY DETECTOR
// ---------------------------
// This service is intentionally independent from TagEvent/TagLatest. It reads
// the same normalized realtime records, keeps a tiny in-memory previous-state
// map, and writes only anomaly records. It never calls UNAI directly.

const previousByTag = new Map();
const openRuleUntil = new Map();
const evaluationQueues = new Map();
let zoneSnapshot = [];
let zoneLoadedAt = 0;
let zoneLoadPromise = null;

function numberEnv(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

const CONFIG = {
  maxSpeed: numberEnv("ANOMALY_MAX_SPEED_MPS", 2.5, 0.01),
  jumpDistance: numberEnv("ANOMALY_MAX_JUMP_DISTANCE_M", 10, 0.1),
  jumpWindowMs: numberEnv("ANOMALY_JUMP_WINDOW_SECONDS", 3, 0.1) * 1000,
  dwellMs: numberEnv("ANOMALY_DWELL_SECONDS", 60, 1) * 1000,
  cooldownMs: numberEnv("ANOMALY_COOLDOWN_SECONDS", 30, 0) * 1000,
  zoneRefreshMs: numberEnv("ANOMALY_ZONE_REFRESH_SECONDS", 300, 5) * 1000,
  staleMs: numberEnv("TAG_ALIVE_TIMEOUT_SECONDS", 10, 1) * 1000,
  enableSpeed: boolEnv("ANOMALY_ENABLE_SPEED", true),
  enableJump: boolEnv("ANOMALY_ENABLE_JUMP", true),
  enableZone: boolEnv("ANOMALY_ENABLE_ZONE", true),
  enableDwell: boolEnv("ANOMALY_ENABLE_DWELL", true),
  enableStale: boolEnv("ANOMALY_ENABLE_STALE", true),
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function first(value, keys) {
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      return object[key];
    }
  }
  return undefined;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function distance3d(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = (a.z == null || b.z == null) ? 0 : Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function severityFor(rule, value, threshold) {
  if (rule === "TAG_STALE") return "HIGH";
  if (rule === "RESTRICTED_ZONE" || rule === "WRONG_ZONE") return "CRITICAL";
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return "MEDIUM";
  const ratio = value / threshold;
  if (ratio >= 3) return "CRITICAL";
  if (ratio >= 2) return "HIGH";
  return "MEDIUM";
}

function rawBoolean(raw, keys) {
  for (const key of keys) {
    const value = first(raw, [key]);
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
  }
  return null;
}

function rawExpectedZone(raw) {
  const value = first(raw, [
    "expectedZoneId",
    "expected_zone_id",
    "expectedZone",
    "expected_zone",
    "expectedZoneName",
    "expected_zone_name",
  ]);
  if (value && typeof value === "object") {
    return first(value, ["id", "zoneId", "zone_id", "name"]);
  }
  return value == null ? null : String(value);
}

function zoneIdOf(zone) {
  return first(zone, ["id", "zone_id", "zoneId", "zoneID"]);
}

function zoneNameOf(zone) {
  return first(zone, ["name", "zone_name", "zoneName", "label", "title"]);
}

function zoneBuildingIdOf(zone) {
  return first(zone, ["building_id", "buildingId", "buildingID"]);
}

function zoneFloorIdOf(zone) {
  return first(zone, ["floor_id", "floorId", "floorID", "floor"]);
}

function isRestrictedZone(zone) {
  const explicit = rawBoolean(zone, ["isRestricted", "is_restricted", "restricted", "isRestrictedZone"]);
  if (explicit !== null) return explicit;
  const type = String(first(zone, ["type", "zone_type", "category", "usage_type"]) ?? "").toLowerCase();
  return /restrict|forbidden|no[-_ ]?entry|prohibited/.test(type);
}

function coordinatePair(value) {
  if (Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    return [Number(value[0]), Number(value[1])];
  }
  if (value && typeof value === "object") {
    const x = first(value, ["x", "lng", "lon", "longitude"]);
    const y = first(value, ["y", "lat", "latitude"]);
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) return [Number(x), Number(y)];
  }
  return null;
}

function collectRings(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    const direct = value.map(coordinatePair);
    if (direct.length >= 3 && direct.every(Boolean)) {
      output.push(direct);
      return output;
    }
    value.forEach((child) => collectRings(child, output));
    return output;
  }
  if (typeof value === "object") {
    for (const key of ["coordinates", "polygon", "points", "vertices", "boundary", "geometry", "shape"]) {
      if (value[key] !== undefined) collectRings(value[key], output);
    }
  }
  return output;
}

function polygonRings(zone) {
  const rings = [];
  for (const key of ["coordinates", "polygon", "points", "vertices", "boundary", "geometry", "shape"]) {
    if (zone?.[key] !== undefined) collectRings(zone[key], rings);
  }
  // GeoJSON Polygon: coordinates is [ring], while MultiPolygon is [polygon].
  return rings.filter((ring) => ring.length >= 3);
}

function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInZone(record, zone) {
  const zoneFloor = zoneFloorIdOf(zone);
  const zoneBuilding = zoneBuildingIdOf(zone);
  if (zoneFloor != null && record.floorId != null && String(zoneFloor) !== String(record.floorId)) return false;
  if (zoneBuilding != null && record.buildingId != null && String(zoneBuilding) !== String(record.buildingId)) return false;
  const rings = polygonRings(zone);
  return rings.some((ring) => pointInPolygon(record, ring));
}

async function loadZones(force = false) {
  const now = Date.now();
  if (!force && zoneSnapshot.length && now - zoneLoadedAt < CONFIG.zoneRefreshMs) return zoneSnapshot;
  if (zoneLoadPromise) return zoneLoadPromise;

  zoneLoadPromise = getCached("zone")
    .then((zones) => {
      zoneSnapshot = Array.isArray(zones) ? zones.filter(Boolean) : [];
      zoneLoadedAt = Date.now();
      return zoneSnapshot;
    })
    .catch((error) => {
      console.warn("[AnomalyDetector] zone cache read failed:", error.message);
      return zoneSnapshot;
    })
    .finally(() => {
      zoneLoadPromise = null;
    });
  return zoneLoadPromise;
}

function cooldownKey(tagId, rule) {
  return `${tagId}:${rule}`;
}

function canEmit(tagId, rule, timestamp) {
  const key = cooldownKey(tagId, rule);
  const until = openRuleUntil.get(key) || 0;
  const time = timestamp.getTime();
  if (time < until) return false;
  openRuleUntil.set(key, time + CONFIG.cooldownMs);
  return true;
}

function anomalyKey({ tagId, rule, timestamp, x, y, zoneId = "" }) {
  return crypto.createHash("sha1").update([
    tagId, rule, timestamp.toISOString(), x ?? "", y ?? "", zoneId,
  ].join("|")).digest("hex");
}

async function persistAnomaly({ record, previous, rule, value = null, threshold = null, unit = null, zoneId = null, zoneName = null, message, metadata = null }) {
  const timestamp = toDate(record.timestamp) || new Date();
  if (!canEmit(String(record.tagId), rule, timestamp)) return null;

  const document = {
    tagId: String(record.tagId),
    buildingId: record.buildingId == null ? null : String(record.buildingId),
    floorId: record.floorId == null ? null : String(record.floorId),
    groupId: record.groupId ?? null,
    groupName: record.groupName == null ? null : String(record.groupName),
    tagName: record.tagName == null ? null : String(record.tagName),
    rule,
    severity: severityFor(rule, value, threshold),
    status: "OPEN",
    message,
    value: Number.isFinite(value) ? value : null,
    threshold: Number.isFinite(threshold) ? threshold : null,
    unit,
    zoneId: zoneId == null ? null : String(zoneId),
    zoneName: zoneName == null ? null : String(zoneName),
    x: toNumber(record.x),
    y: toNumber(record.y),
    z: toNumber(record.z),
    previousX: previous ? toNumber(previous.x) : null,
    previousY: previous ? toNumber(previous.y) : null,
    previousZ: previous ? toNumber(previous.z) : null,
    previousTimestamp: previous?.timestamp ? toDate(previous.timestamp) : null,
    timestamp,
    receivedAt: new Date(),
    eventKey: anomalyKey({ tagId: String(record.tagId), rule, timestamp, x: record.x, y: record.y, zoneId }),
    metadata,
  };

  try {
    return await AnomalyEvent.create(document);
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function evaluateRecordInternal(record) {
  if (!record || record.tagId == null) return [];
  const timestamp = toDate(record.timestamp) || new Date();
  const normalized = { ...record, timestamp };
  const tagId = String(record.tagId);
  const previous = previousByTag.get(tagId);
  const anomalies = [];

  if (previous) {
    const previousTimestamp = toDate(previous.timestamp);
    const elapsedMs = previousTimestamp ? timestamp.getTime() - previousTimestamp.getTime() : 0;
    if (elapsedMs > 0) {
      const distance = distance3d(normalized, previous);
      const seconds = elapsedMs / 1000;
      const speed = distance / seconds;

      if (CONFIG.enableSpeed && speed > CONFIG.maxSpeed) {
        const saved = await persistAnomaly({
          record: normalized,
          previous,
          rule: "SPEED_TOO_HIGH",
          value: speed,
          threshold: CONFIG.maxSpeed,
          unit: "m/s",
          message: `Tag ${tagId} speed ${speed.toFixed(2)} m/s exceeds ${CONFIG.maxSpeed.toFixed(2)} m/s`,
          metadata: { distanceMeters: distance, elapsedSeconds: seconds },
        });
        if (saved) anomalies.push(saved);
      }

      if (
        CONFIG.enableJump &&
        distance > CONFIG.jumpDistance &&
        elapsedMs <= CONFIG.jumpWindowMs
      ) {
        const saved = await persistAnomaly({
          record: normalized,
          previous,
          rule: "SUDDEN_POSITION_JUMP",
          value: distance,
          threshold: CONFIG.jumpDistance,
          unit: "m",
          message: `Tag ${tagId} jumped ${distance.toFixed(2)} m in ${seconds.toFixed(2)} s`,
          metadata: { elapsedSeconds: seconds },
        });
        if (saved) anomalies.push(saved);
      }
    }

    const samePosition = distance3d(normalized, previous) < numberEnv("ANOMALY_STATIONARY_DISTANCE_M", 0.2, 0);
    const dwellStart = previous.dwellStart ? toDate(previous.dwellStart) : null;
    const nextDwellStart = samePosition ? (dwellStart || previousTimestampFrom(previous) || timestamp) : null;

    if (CONFIG.enableDwell && nextDwellStart && timestamp.getTime() - nextDwellStart.getTime() >= CONFIG.dwellMs) {
      const saved = await persistAnomaly({
        record: normalized,
        previous,
        rule: "DWELL_TIME",
        value: (timestamp.getTime() - nextDwellStart.getTime()) / 1000,
        threshold: CONFIG.dwellMs / 1000,
        unit: "seconds",
        message: `Tag ${tagId} remained stationary for ${Math.round((timestamp.getTime() - nextDwellStart.getTime()) / 1000)} seconds`,
        metadata: { dwellStart: nextDwellStart.toISOString() },
      });
      if (saved) anomalies.push(saved);
    }
  }

  if (CONFIG.enableZone) {
    const raw = asObject(record.rawData) || {};
    const explicitExpected = rawBoolean(raw, ["inExpectedZone", "in_expected_zone"]);
    if (explicitExpected === false) {
      const expected = rawExpectedZone(raw);
      const saved = await persistAnomaly({
        record: normalized,
        previous,
        rule: "WRONG_ZONE",
        message: `Tag ${tagId} is outside its expected zone${expected ? ` (${expected})` : ""}`,
        metadata: { expectedZone: expected },
      });
      if (saved) anomalies.push(saved);
    }

    const zones = await loadZones();
    for (const zone of zones) {
      if (!isRestrictedZone(zone) || !pointInZone(normalized, zone)) continue;
      const saved = await persistAnomaly({
        record: normalized,
        previous,
        rule: "RESTRICTED_ZONE",
        zoneId: zoneIdOf(zone),
        zoneName: zoneNameOf(zone),
        message: `Tag ${tagId} entered restricted zone${zoneNameOf(zone) ? ` ${zoneNameOf(zone)}` : ""}`,
      });
      if (saved) anomalies.push(saved);
      break;
    }
  }

  const previousTimestamp = toDate(previous?.timestamp);
  const samePosition = previous && distance3d(normalized, previous) < numberEnv("ANOMALY_STATIONARY_DISTANCE_M", 0.2, 0);
  const dwellStart = samePosition
    ? (toDate(previous.dwellStart) || previousTimestamp || timestamp)
    : null;

  previousByTag.set(tagId, {
    ...normalized,
    dwellStart: dwellStart ? dwellStart.toISOString() : null,
    lastSeenAt: timestamp.toISOString(),
    stale: false,
  });

  return anomalies;
}

async function evaluateRecord(record) {
  if (!record || record.tagId == null) return [];
  const tagId = String(record.tagId);
  const previousQueue = evaluationQueues.get(tagId) || Promise.resolve();
  const currentQueue = previousQueue
    .catch(() => undefined)
    .then(() => evaluateRecordInternal(record));

  evaluationQueues.set(tagId, currentQueue);
  try {
    return await currentQueue;
  } finally {
    if (evaluationQueues.get(tagId) === currentQueue) evaluationQueues.delete(tagId);
  }
}

function previousTimestampFrom(previous) {
  return toDate(previous?.timestamp);
}

async function markStale(activeTags) {
  if (!CONFIG.enableStale || !Array.isArray(activeTags)) return [];
  const now = Date.now();
  const anomalies = [];

  for (const tag of activeTags) {
    if (!tag?.tagId) continue;
    const tagId = String(tag.tagId);
    const timestamp = toDate(tag.lastSeen);
    if (!timestamp) continue;
    const stale = now - timestamp.getTime() >= CONFIG.staleMs;
    const previous = previousByTag.get(tagId);

    if (stale && !previous?.stale) {
      const saved = await persistAnomaly({
        record: {
          ...tag,
          timestamp,
          tagId,
        },
        previous,
        rule: "TAG_STALE",
        value: (now - timestamp.getTime()) / 1000,
        threshold: CONFIG.staleMs / 1000,
        unit: "seconds",
        message: `Tag ${tagId} has not reported for ${Math.round((now - timestamp.getTime()) / 1000)} seconds`,
      });
      if (saved) anomalies.push(saved);
    }

    if (previous) {
      previousByTag.set(tagId, { ...previous, stale });
    } else {
      previousByTag.set(tagId, {
        ...tag,
        tagId,
        timestamp,
        stale,
        dwellStart: null,
      });
    }
  }

  return anomalies;
}

async function refreshZones() {
  return loadZones(true);
}

function getStatus() {
  return {
    enabled: true,
    config: { ...CONFIG },
    trackedTags: previousByTag.size,
    zoneCount: zoneSnapshot.length,
    zoneLoadedAt: zoneLoadedAt || null,
  };
}

module.exports = {
  evaluateRecord,
  markStale,
  refreshZones,
  getStatus,
};
