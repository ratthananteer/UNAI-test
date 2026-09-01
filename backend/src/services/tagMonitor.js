// ACTIVE TAG MONITOR:
// Periodically checks recent TagEvent records in MongoDB.
// ASSET events are excluded from the active-tag cache.

const TagEvent = require("../models/TagEvent");

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

  // Existing ASSET events may already be in MongoDB. Exclude them before
  // grouping so an old Asset record can never become the latest tag position.
  const latest = await TagEvent.aggregate([
    {
      $match: {
        $nor: [
          { "rawData.usage_type": { $regex: /^asset$/i } },
          { "rawData.usageType": { $regex: /^asset$/i } },
          { "rawData.usage.type": { $regex: /^asset$/i } },
        ],
      },
    },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: "$tagId",
        latest: { $first: "$$ROOT" },
      },
    },
  ]);

  const next = new Map();

  for (const item of latest) {
    const event = item.latest;
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
    `[TagMonitor] Started: timeout=${getTimeoutMs() / 1000}s, interval=${getIntervalMs() / 1000}s`
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
