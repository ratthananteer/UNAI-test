const express = require("express");
const TagEvent = require("../models/TagEvent");

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

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const inputEvents = Array.isArray(body.events) ? body.events : [body];

    const documents = [];

    for (const item of inputEvents) {
      const tagId = item.tagId ?? item.tag_id ?? item.id;
      const x = Number(item.x);
      const y = Number(item.y);

      if (tagId === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
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
        x,
        y,
        z: Number.isFinite(Number(item.z)) ? Number(item.z) : null,
        timestamp: parseTimestamp(item.timestamp),
        rawData: item.rawData ?? item,
      });
    }

    if (documents.length === 0) {
      return res.status(400).json({
        error: "No valid tag events. tagId, x and y are required.",
      });
    }

    const events = await TagEvent.insertMany(documents, { ordered: false });

    //console.log(`[TagEvent] Saved ${events.length} event(s)`);

    return res.status(201).json({
      ok: true,
      count: events.length,
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
    const filter = {};
    if (req.query.buildingId) filter.buildingId = String(req.query.buildingId);
    if (req.query.floorId) filter.floorId = String(req.query.floorId);
    if (req.query.tagId) filter.tagId = String(req.query.tagId);

    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;

    const events = await TagEvent.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.json(events);
  } catch (error) {
    console.error("[TagEvent] query failed:", error);
    return res.status(500).json({
      error: "Failed to load tag events",
    });
  }
});

module.exports = router;
