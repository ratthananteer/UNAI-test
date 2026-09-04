// TAG EVENT API:
// POST /api/tag-events saves normalized Socket.IO tag positions to MongoDB.
// GET /api/tag-events reads historical positions with optional building,
// floor, and tag filters. ASSET records are intentionally ignored.

const express = require("express");
const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, isAssetOrKnownAsset } = require("../services/assetFilter");

const router = express.Router();

function configNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// History is sampled independently from TagLatest. TagLatest always keeps the
// newest position, while TagEvent only keeps a meaningful movement/state change.
const HISTORY_MIN_INTERVAL_MS = configNumber("TAG_HISTORY_MIN_INTERVAL_MS", 1000);
const HISTORY_MIN_DISTANCE = configNumber("TAG_HISTORY_MIN_DISTANCE", 0.2);

function eventKeyOf(document) {
  return [
    document.tagId,
    document.floorId ?? "",
    document.timestamp.getTime(),
    document.x,
    document.y,
    document.z ?? "",
  ].join("|");
}

function shouldPersistHistory(document, previous) {
  if (!previous) return true;
  if (document.event !== "position_update") return true;
  if (String(document.floorId ?? "") !== String(previous.floorId ?? "")) return true;

  const previousTimestamp = new Date(previous.timestamp).getTime();
  const elapsed = document.timestamp.getTime() - previousTimestamp;
  const dx = Number(document.x) - Number(previous.x);
  const dy = Number(document.y) - Number(previous.y);
  const distance = Math.sqrt((dx * dx) + (dy * dy));

  // Protect against out-of-order packets. A newer packet can still update
  // TagLatest, but it should not create a backwards history point.
  if (elapsed <= 0) return false;
  return elapsed >= HISTORY_MIN_INTERVAL_MS || distance >= HISTORY_MIN_DISTANCE;
}

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

// Asset filtering is denormalized into isAsset/tagId. Avoid regex scans on
// rawData because TagEvent is the high-volume collection.

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

    documents.forEach((document) => {
      document.eventKey = eventKeyOf(document);
    });

    // Read the current snapshot once for the whole request. This is used for
    // both history sampling and the latest read model, avoiding one query per tag.
    const tagIds = [...new Set(documents.map((document) => document.tagId))];
    const existingLatest = await TagLatest.find({ tagId: { $in: tagIds } })
      .select({ tagId: 1, floorId: 1, x: 1, y: 1, z: 1, timestamp: 1 })
      .lean();
    const existingByTag = new Map(existingLatest.map((row) => [String(row.tagId), row]));

    // Only persist meaningful history points. TagLatest still receives every
    // newer position so the live map never loses realtime precision.
    const historyDocuments = [];
    const historyCandidateByTag = new Map(existingByTag);
    for (const document of documents) {
      const id = document.tagId;
      const previous = historyCandidateByTag.get(id);
      if (shouldPersistHistory(document, previous)) {
        historyDocuments.push(document);
        historyCandidateByTag.set(id, document);
      }
    }

    // The unique eventKey index protects against duplicate packets from two
    // browser subscribers. Ordered=false lets unique-key duplicates be ignored
    // without failing the entire batch.
    let events = [];
    if (historyDocuments.length) {
      try {
        events = await TagEvent.insertMany(historyDocuments, { ordered: false });
      } catch (error) {
        if (error?.code !== 11000 && !Array.isArray(error?.writeErrors)) throw error;
        events = Array.isArray(error?.insertedDocs) ? error.insertedDocs : [];
        console.warn("[TagEvent] Duplicate history event(s) ignored");
      }
    }

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
      const latestOperations = [];
      for (const [id, document] of latestByTag) {
        const existing = existingByTag.get(String(id));
        const existingTimestamp = existing?.timestamp;
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

    console.log(
      `[TagEvent] Saved ${events.length} event(s), ` +
      `ignored_asset=${assetCount}, invalid=${invalidCount}`
    );

    return res.status(201).json({
      ok: true,
      count: events.length,
      ignoredAssetCount: assetCount,
      invalidCount,
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
    const filter = { isAsset: { $ne: true } };

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
