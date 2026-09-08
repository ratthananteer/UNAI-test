const express = require("express");
const AnomalyEvent = require("../models/AnomalyEvent");
const { getStatus, refreshZones } = require("../services/anomalyDetector");

const router = express.Router();

function safeLimit(value, fallback = 100) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 1000) : fallback;
}

// GET /api/anomalies/status
// Operational visibility without exposing internal socket credentials.
router.get("/status", (req, res) => {
  return res.json({ ok: true, ...getStatus() });
});

// POST /api/anomalies/refresh-zones
// Reads the already-synchronized MongoDB zone cache only. No direct UNAI call.
router.post("/refresh-zones", async (req, res) => {
  try {
    const zones = await refreshZones();
    return res.json({ ok: true, zoneCount: zones.length });
  } catch (error) {
    return res.status(500).json({ error: "Failed to refresh anomaly zones", details: error.message });
  }
});

// GET /api/anomalies
// Supports tag/building/floor/rule/severity/status/time filters.
router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.tagId) filter.tagId = String(req.query.tagId);
    if (req.query.buildingId) filter.buildingId = String(req.query.buildingId);
    if (req.query.floorId) filter.floorId = String(req.query.floorId);
    if (req.query.rule) filter.rule = String(req.query.rule);
    if (req.query.severity) filter.severity = String(req.query.severity).toUpperCase();
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();

    if (req.query.from) {
      const from = new Date(String(req.query.from));
      if (Number.isNaN(from.getTime())) return res.status(400).json({ error: "Invalid from date" });
      filter.timestamp = { $gte: from };
    }
    if (req.query.to) {
      const to = new Date(String(req.query.to));
      if (Number.isNaN(to.getTime())) return res.status(400).json({ error: "Invalid to date" });
      filter.timestamp = { ...(filter.timestamp || {}), $lte: to };
    }

    const limit = safeLimit(req.query.limit);
    const skipValue = Number(req.query.skip);
    const skip = Number.isFinite(skipValue) ? Math.min(Math.max(Math.floor(skipValue), 0), 1_000_000) : 0;

    const items = await AnomalyEvent.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.json({
      items,
      limit,
      skip,
      hasMore: items.length === limit,
    });
  } catch (error) {
    console.error("[AnomalyEvent] query failed:", error);
    return res.status(500).json({ error: "Failed to load anomalies", details: error.message });
  }
});

// PATCH /api/anomalies/:id/resolve
// Manual acknowledgement. This does not alter TagEvent/TagLatest.
router.patch("/:id/resolve", async (req, res) => {
  try {
    const item = await AnomalyEvent.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "RESOLVED" } },
      { new: true },
    ).lean();
    if (!item) return res.status(404).json({ error: "Anomaly not found" });
    return res.json({ ok: true, item });
  } catch (error) {
    console.error("[AnomalyEvent] resolve failed:", error);
    return res.status(500).json({ error: "Failed to resolve anomaly", details: error.message });
  }
});

module.exports = router;
