const express = require("express");
const { fetchFromApi, generateSocketTopic } = require("../services/unaiApi");
const tagEventsRouter = require("./tagEvents");
const { getActiveTags, refreshActiveTags } = require("../services/tagMonitor");
const { getCachedOrFetch, refreshStaticData } = require("../services/staticDataCache");

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

// Static RTLS data is cache-first. The first request populates MongoDB;
// subsequent web requests read MongoDB and do not hit the RTLS API.
function cachedProxyGet(path, type, envName, errorMessage) {
  router.get(path, async (req, res) => {
    try {
      console.log(`[WEB DATA] GET ${path}`);
      const data = await getCachedOrFetch(type, () =>
        fetchFromApi(process.env[envName], errorMessage),
      );
      console.log(`[WEB DATA] ${path} -> ${Array.isArray(data) ? data.length : 0} records`);
      res.json(data);
    } catch (error) {
      console.error(`[StaticData] ${path} failed:`, error);
      res.status(error.status || 500).json({
        error: error.message || "Server error",
        details: error.body || undefined,
      });
    }
  });
}

router.post("/sync-static-data", async (req, res) => {
  try {
    const requested = req.body?.types;
    const types = Array.isArray(requested) && requested.length
      ? requested
      : ["building", "floor", "zone", "place"];

    const config = {
      building: ["APIBUILDING_URL", "Failed to get buildings"],
      floor: ["APIFLOOR_URL", "Failed to get floors"],
      zone: ["APIZONE_URL", "Failed to get zones"],
      place: ["APIPLACE_URL", "Failed to get places"],
    };

    const result = {};
    for (const type of types) {
      if (!config[type]) continue;
      const [envName, errorMessage] = config[type];
      result[type] = await refreshStaticData(type, () =>
        fetchFromApi(process.env[envName], errorMessage),
      );
    }

    return res.json({ ok: true, data: result });
  } catch (error) {
    console.error("/api/sync-static-data error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Failed to sync static data",
      details: error.body || undefined,
    });
  }
});

cachedProxyGet("/floors", "floor", "APIFLOOR_URL", "Failed to get floors");
proxyGet("/anchor", "APIANCHOR_URL", "Failed to get anchors");
proxyGet("/tag", "APITAG_URL", "Failed to get tags");
cachedProxyGet("/zone", "zone", "APIZONE_URL", "Failed to get zones");
cachedProxyGet("/v1/get_all_place", "place", "APIPLACE_URL", "Failed to get places");
cachedProxyGet("/v1/get_all_building", "building", "APIBUILDING_URL", "Failed to get buildings");

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
