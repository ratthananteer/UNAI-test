// ACTIVE TAG MONITOR:
// Reads the latest snapshot for each tag from MongoDB.
// TagEvent remains the historical append-only collection; TagLatest is the
// optimized read model used for frequent ONLINE/OFFLINE checks.

const TagLatest = require("../models/TagLatest");
const { getAssetTagIds } = require("./assetFilter");

let monitorTimer = null;
let latestActiveTags = new Map();

function configNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getTimeoutMs() {
  return configNumber("TAG_ALIVE_TIMEOUT_SECONDS", 10) * 1000;
}

function getIntervalMs() {
  return configNumber("TAG_SCREEN_INTERVAL_SECONDS", 2) * 1000;
}

async function refreshActiveTags() {
  const timeoutDate = new Date(Date.now() - getTimeoutMs());
  const assetTagIds = await getAssetTagIds();

  const match = { isAsset: { $ne: true } };
  if (assetTagIds.size > 0) {
    match.tagId = { $nin: [...assetTagIds] };
  }

  // TagLatest contains one document per tag, so this query is proportional to
  // the number of current tags rather than the full TagEvent history volume.
  const latest = await TagLatest.find(match)
    .select({
      _id: 0,
      tagId: 1,
      buildingId: 1,
      floorId: 1,
      x: 1,
      y: 1,
      z: 1,
      groupId: 1,
      groupName: 1,
      tagName: 1,
      timestamp: 1,
    })
    .lean();

  const next = new Map();

  for (const event of latest) {
    const eventTime = new Date(event.timestamp).getTime();
    const isAlive = Number.isFinite(eventTime) && eventTime >= timeoutDate.getTime();

    next.set(String(event.tagId), {
      tagId: String(event.tagId),
      buildingId: event.buildingId,
      floorId: event.floorId,
      x: event.x,
      y: event.y,
      z: event.z,
      groupId: event.groupId,
      groupName: event.groupName,
      tagName: event.tagName,
      lastSeen: event.timestamp,
      status: isAlive ? "ALIVE" : "STALE",
    });
  }

  latestActiveTags = next;
  return next;
}

function startTagMonitor() {
  if (monitorTimer) return;

  const run = async () => {
    try {
      await refreshActiveTags();
    } catch (error) {
      console.error("[TagMonitor] refresh failed:", error.message);
    }
  };

  void run();
  monitorTimer = setInterval(() => void run(), getIntervalMs());
  console.log(
    `[TagMonitor] Started: timeout=${getTimeoutMs() / 1000}s, interval=${getIntervalMs() / 1000}s`,
  );
}

function getActiveTags({ buildingId, floorId } = {}) {
  const result = [];

  for (const tag of latestActiveTags.values()) {
    if (buildingId != null && String(tag.buildingId) !== String(buildingId)) continue;
    if (floorId != null && String(tag.floorId) !== String(floorId)) continue;
    result.push(tag);
  }

  return result;
}

module.exports = {
  startTagMonitor,
  refreshActiveTags,
  getActiveTags,
};
