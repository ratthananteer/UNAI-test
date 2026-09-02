// TAG EVENT API:
// POST /api/tag-events saves normalized Socket.IO tag positions to MongoDB.
// GET /api/tag-events reads historical positions with optional building,
// floor, and tag filters. ASSET records are intentionally ignored.

const express = require("express");
const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, isAssetOrKnownAsset } = require("../services/assetFilter");
const { processGeofenceEvents } = require("../services/geofence");

const router = express.Router();


function parseTimestamp(value) {
  if (typeof value === "number") {
    const ms = value < 100000000000 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }

  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

const ASSET_QUERY = {
  $nor: [
    { "rawData.usage_type": { $regex: /^asset$/i } },
    { "rawData.usageType": { $regex: /^asset$/i } },
    { "rawData.usage.type": { $regex: /^asset$/i } },
  ],
};

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const inputEvents = Array.isArray(body.events) ? body.events : [body];

    const documents = [];
    let assetCount = 0;
    let invalidCount = 0;
    const assetTagIds = await getAssetTagIds();

    for (const item of inputEvents) {
      // Reject ASSET before it reaches MongoDB.
      if (
        isAssetOrKnownAsset(item, assetTagIds) ||
        isAssetOrKnownAsset(item?.rawData, assetTagIds)
      ) {
        assetCount += 1;
        continue;
      }

      const tagId = item.tagId ?? item.tag_id ?? item.id;
      const x = Number(item.x);
      const y = Number(item.y);

      if (tagId === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        invalidCount += 1;
        continue;
      }

      documents.push({
        tagId: String(tagId),
        buildingId: item.buildingId == null ? null : String(item.buildingId),
        floorId: item.floorId == null ? null : String(item.floorId),
        groupId: item.groupId ?? null,
        groupName: item.groupName == null ? null : String(item.groupName),
        tagName: item.tagName == null ? null : String(item.tagName),
        event: String(item.event || "position_update"),
        isAsset: false,
        x,
        y,
        z: Number.isFinite(Number(item.z)) ? Number(item.z) : null,
        timestamp: parseTimestamp(item.timestamp),
        rawData: item.rawData ?? item,
      });
    }

    if (documents.length === 0) {
      return res.status(400).json({
        error: assetCount > 0
          ? "No valid tag events. ASSET records are ignored."
          : "No valid tag events. tagId, x and y are required.",
        ignoredAssetCount: assetCount,
        invalidCount,
      });
    }

    const events = await TagEvent.insertMany(documents, { ordered: false });

    // Maintain one latest snapshot per tag. This turns active-tag reads into
    // a small indexed query instead of an aggregation over TagEvent history.
    const latestByTag = new Map();
    for (const document of documents) {
      const previous = latestByTag.get(document.tagId);
      if (!previous || document.timestamp > previous.timestamp) {
        latestByTag.set(document.tagId, document);
      }
    }

    if (latestByTag.size) {
      const existing = await TagLatest.find({
        tagId: { $in: [...latestByTag.keys()] },
      })
        .select({ tagId: 1, timestamp: 1 })
        .lean();
      const existingByTag = new Map(existing.map((row) => [row.tagId, row.timestamp]));

      const latestOperations = [];
      for (const [id, document] of latestByTag) {
        const existingTimestamp = existingByTag.get(id);
        if (existingTimestamp && new Date(existingTimestamp).getTime() >= document.timestamp.getTime()) {
          continue;
        }

        latestOperations.push({
          updateOne: {
            filter: { tagId: id },
            update: {
              $set: {
                tagId: id,
                buildingId: document.buildingId,
                floorId: document.floorId,
                groupId: document.groupId,
                groupName: document.groupName,
                tagName: document.tagName,
                status: document.status || "ALIVE",
                movementStatus: document.movementStatus || "UNKNOWN",
                isAsset: false,
                x: document.x,
                y: document.y,
                z: document.z,
                timestamp: document.timestamp,
                receivedAt: document.receivedAt || new Date(),
              },
            },
            upsert: true,
          },
        });
      }

      if (latestOperations.length) {
        await TagLatest.bulkWrite(latestOperations, { ordered: false });
      }
    }

    let geofenceTransitions = [];
    try {
      const geofenceResult = await processGeofenceEvents(documents);
      geofenceTransitions = geofenceResult.transitions || [];
    } catch (geofenceError) {
      // A malformed/missing zone must never stop RTLS position history from
      // being saved. Geofencing is an additional read model on top of tags.
      console.error("[Geofence] Processing failed:", geofenceError);
    }

    console.log(
      `[TagEvent] Saved ${events.length} event(s), ` +
      `ignored_asset=${assetCount}, invalid=${invalidCount}, ` +
      `geofence_transitions=${geofenceTransitions.length}`
    );

    return res.status(201).json({
      ok: true,
      count: events.length,
      ignoredAssetCount: assetCount,
      invalidCount,
      geofenceTransitions,
      ids: events.map((event) => event._id),
    });
  } catch (error) {
    console.error("[TagEvent] save failed:", error);
    return res.status(500).json({
      error: "Failed to save tag event",
      details: error.message,
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const assetTagIds = await getAssetTagIds();
    const filter = { ...ASSET_QUERY };

    // Socket location events may not contain usage_type. Exclude those known
    // Asset IDs as well, including Asset records that were stored previously.
    if (assetTagIds.size > 0) {
      filter.tagId = { $nin: [...assetTagIds] };
    }

    if (req.query.buildingId) filter.buildingId = String(req.query.buildingId);
    if (req.query.floorId) filter.floorId = String(req.query.floorId);
    if (req.query.from) {
      const from = new Date(String(req.query.from));
      if (Number.isNaN(from.getTime())) return res.status(400).json({ error: "Invalid from date" });
      filter.timestamp = { ...(filter.timestamp || {}), $gte: from };
    }
    if (req.query.to) {
      const to = new Date(String(req.query.to));
      if (Number.isNaN(to.getTime())) return res.status(400).json({ error: "Invalid to date" });
      filter.timestamp = { ...(filter.timestamp || {}), $lte: to };
    }
    if (req.query.tagId) {
      const requestedTagId = String(req.query.tagId);
      if (assetTagIds.has(requestedTagId)) {
        return res.json([]);
      }
      filter.tagId = requestedTagId;
    }

    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 5000)
      : 500;
    const requestedSkip = Number(req.query.skip);
    const skip = Number.isFinite(requestedSkip)
      ? Math.min(Math.max(Math.floor(requestedSkip), 0), 1_000_000)
      : 0;

    const events = await TagEvent.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .select({
        tagId: 1,
        buildingId: 1,
        floorId: 1,
        groupId: 1,
        groupName: 1,
        tagName: 1,
        event: 1,
        status: 1,
        movementStatus: 1,
        x: 1,
        y: 1,
        z: 1,
        timestamp: 1,
        receivedAt: 1,
      })
      .lean();

    return res.json({
      items: events,
      limit,
      skip,
      hasMore: events.length === limit,
    });
  } catch (error) {
    console.error("[TagEvent] query failed:", error);
    return res.status(500).json({
      error: "Failed to load tag events",
      details: error.message,
    });
  }
});

module.exports = router;
