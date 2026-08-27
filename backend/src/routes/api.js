const express = require("express");
const { fetchFromApi, generateSocketTopic } = require("../services/unaiApi");
const tagEventsRouter = require("./tagEvents");
const { getActiveTags, refreshActiveTags } = require("../services/tagMonitor");

const router = express.Router();

// Render health check. This endpoint does not depend on MongoDB so the
// platform can verify that the HTTP server is reachable.
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "unai-backend" });
});

function proxyGet(path, envName, errorMessage) {
  router.get(path, async (req, res) => {
    try {
      const data = await fetchFromApi(process.env[envName], errorMessage);
      res.json(data);
    } catch (error) {
      console.error(error);
      res.status(error.status || 500).json({
        error: error.message || "Server error",
        details: error.body || undefined,
      });
    }
  });
}

proxyGet("/floors", "APIFLOOR_URL", "Failed to get floors");
proxyGet("/anchor", "APIANCHOR_URL", "Failed to get anchors");
proxyGet("/tag", "APITAG_URL", "Failed to get tags");
proxyGet("/zone", "APIZONE_URL", "Failed to get zones");
proxyGet("/v1/get_all_place", "APIPLACE_URL", "Failed to get places");
proxyGet("/v1/get_all_building", "APIBUILDING_URL", "Failed to get buildings");

router.post("/socket-topic", async (req, res) => {
  try {
    const floorID = req.body?.floorID ?? req.query?.floorID;
    if (floorID === undefined || floorID === null || floorID === "") {
      return res.status(400).json({ error: "floorID is required" });
    }

    const data = await generateSocketTopic(floorID);
    return res.json(data);
  } catch (error) {
    console.error("/api/socket-topic error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Server error",
      details: error.body || undefined,
    });
  }
});

// Socket.IO events received by the frontend are persisted through this API.
router.use("/tag-events", tagEventsRouter);

// Returns tags whose latest database activity is within the alive timeout.
router.get("/active-tags", async (req, res) => {
  try {
    await refreshActiveTags();
    return res.json({
      ok: true,
      timeoutSeconds: Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10,
      tags: getActiveTags({
        buildingId: req.query.buildingId,
        floorId: req.query.floorId,
      }),
    });
  } catch (error) {
    console.error("/api/active-tags error:", error);
    return res.status(500).json({
      error: "Failed to check active tags",
      details: error.message,
    });
  }
});

module.exports = router;
