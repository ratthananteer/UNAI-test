const express = require("express");
const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");

const router = express.Router();
const DEFAULT_RANGE_HOURS = 24;
const MAX_RANGE_DAYS = 30;

function parseDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function getRange(req) {
  const now = new Date();
  const hours = Math.min(
    Math.max(Number(req.query.hours) || DEFAULT_RANGE_HOURS, 1),
    MAX_RANGE_DAYS * 24,
  );
  const to = parseDate(req.query.to, now);
  const from = parseDate(req.query.from, new Date(to.getTime() - hours * 60 * 60 * 1000));
  return { from, to };
}

function baseLatestMatch(req) {
  const match = { isAsset: { $ne: true } };
  if (req.query.buildingId) match.buildingId = String(req.query.buildingId);
  if (req.query.floorId) match.floorId = String(req.query.floorId);
  if (req.query.groupId) match.groupId = String(req.query.groupId);
  return match;
}

function baseEventMatch(req, from, to) {
  const match = {
    isAsset: { $ne: true },
    timestamp: { $gte: from, $lte: to },
  };
  if (req.query.buildingId) match.buildingId = String(req.query.buildingId);
  if (req.query.floorId) match.floorId = String(req.query.floorId);
  if (req.query.groupId) match.groupId = String(req.query.groupId);
  return match;
}

router.get("/summary", async (req, res) => {
  try {
    const { from, to } = getRange(req);
    const latestMatch = baseLatestMatch(req);
    const eventMatch = baseEventMatch(req, from, to);

    const [totalTags, onlineTags, movingTags, totalEvents, buildings, floors] = await Promise.all([
      TagLatest.countDocuments(latestMatch),
      TagLatest.countDocuments({ ...latestMatch, status: "ALIVE" }),
      TagLatest.countDocuments({ ...latestMatch, movementStatus: "MOVING" }),
      TagEvent.countDocuments(eventMatch),
      TagLatest.aggregate([
        { $match: latestMatch },
        { $group: { _id: "$buildingId", count: { $sum: 1 } } },
      ]),
      TagLatest.aggregate([
        { $match: latestMatch },
        { $group: { _id: "$floorId", count: { $sum: 1 } } },
      ]),
    ]);

    return res.json({
      ok: true,
      range: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        totalTags,
        onlineTags,
        offlineTags: Math.max(totalTags - onlineTags, 0),
        movingTags,
        totalEvents,
        buildingCount: buildings.length,
        floorCount: floors.length,
      },
    });
  } catch (error) {
    console.error("/api/analytics/summary error:", error);
    return res.status(500).json({ error: "Failed to load analytics summary", details: error.message });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const { from, to } = getRange(req);
    const buckets = Math.min(Math.max(Number(req.query.buckets) || 24, 6), 168);
    const bucketMs = (to.getTime() - from.getTime()) / buckets;
    const rows = await TagEvent.aggregate([
      { $match: baseEventMatch(req, from, to) },
      {
        $project: {
          timestamp: 1,
          bucket: {
            $dateTrunc: {
              date: "$timestamp",
              unit: bucketMs >= 24 * 60 * 60 * 1000 ? "day" : bucketMs >= 60 * 60 * 1000 ? "hour" : "minute",
              binSize: bucketMs >= 24 * 60 * 60 * 1000 ? Math.max(1, Math.round(bucketMs / (24 * 60 * 60 * 1000))) : bucketMs >= 60 * 60 * 1000 ? Math.max(1, Math.round(bucketMs / (60 * 60 * 1000))) : Math.max(1, Math.round(bucketMs / 60000)),
            },
          },
        },
      },
      { $group: { _id: "$bucket", events: { $sum: 1 }, activeTags: { $addToSet: "$tagId" } } },
      { $project: { _id: 0, timestamp: "$_id", events: 1, activeTags: { $size: "$activeTags" } } },
      { $sort: { timestamp: 1 } },
    ]);

    return res.json({ ok: true, range: { from: from.toISOString(), to: to.toISOString() }, items: rows });
  } catch (error) {
    console.error("/api/analytics/activity error:", error);
    return res.status(500).json({ error: "Failed to load activity analytics", details: error.message });
  }
});

router.get("/distribution", async (req, res) => {
  try {
    const match = baseLatestMatch(req);
    const [byBuilding, byFloor, byGroup] = await Promise.all([
      TagLatest.aggregate([
        { $match: match },
        { $group: { _id: { id: "$buildingId", name: "$buildingName" }, count: { $sum: 1 }, online: { $sum: { $cond: [{ $eq: ["$status", "ALIVE"] }, 1, 0] } } } },
        { $sort: { count: -1, "_id.name": 1 } },
        { $limit: 20 },
      ]),
      TagLatest.aggregate([
        { $match: match },
        { $group: { _id: { id: "$floorId", name: "$floorName" }, count: { $sum: 1 }, online: { $sum: { $cond: [{ $eq: ["$status", "ALIVE"] }, 1, 0] } } } },
        { $sort: { count: -1, "_id.name": 1 } },
        { $limit: 30 },
      ]),
      TagLatest.aggregate([
        { $match: match },
        { $group: { _id: { id: "$groupId", name: "$groupName" }, count: { $sum: 1 }, online: { $sum: { $cond: [{ $eq: ["$status", "ALIVE"] }, 1, 0] } } } },
        { $sort: { count: -1, "_id.name": 1 } },
        { $limit: 20 },
      ]),
    ]);

    const normalize = (items) => items.map((item) => ({
      id: item._id?.id ?? null,
      name: item._id?.name || item._id?.id || "Unknown",
      count: item.count,
      online: item.online,
    }));

    return res.json({ ok: true, byBuilding: normalize(byBuilding), byFloor: normalize(byFloor), byGroup: normalize(byGroup) });
  } catch (error) {
    console.error("/api/analytics/distribution error:", error);
    return res.status(500).json({ error: "Failed to load analytics distribution", details: error.message });
  }
});

router.get("/top-moving", async (req, res) => {
  try {
    const { from, to } = getRange(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const rows = await TagEvent.aggregate([
      { $match: { ...baseEventMatch(req, from, to), event: "position_update" } },
      { $group: { _id: "$tagId", tagName: { $last: "$tagName" }, events: { $sum: 1 }, lastSeen: { $max: "$timestamp" } } },
      { $sort: { events: -1, lastSeen: -1 } },
      { $limit: limit },
      { $project: { _id: 0, tagId: "$_id", tagName: 1, events: 1, lastSeen: 1 } },
    ]);
    return res.json({ ok: true, range: { from: from.toISOString(), to: to.toISOString() }, items: rows });
  } catch (error) {
    console.error("/api/analytics/top-moving error:", error);
    return res.status(500).json({ error: "Failed to load top moving tags", details: error.message });
  }
});

module.exports = router;
