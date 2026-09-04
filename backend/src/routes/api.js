// MAIN API ROUTES:
// Defines the backend HTTP endpoints used by the frontend.
// Static data routes use MongoDB cache-first loading; live RTLS endpoints
// proxy through the UNAI authentication/API service; tag history and active-tag
// endpoints use MongoDB data. All routes are mounted under /api in src/server.js.

const express = require("express");
const { fetchFromApi, generateSocketTopic } = require("../services/unaiApi");
const { generateAccessToken } = require("../services/unaiAuth");
const tagEventsRouter = require("./tagEvents");
const adminRouter = require("./admin");
const { getActiveTags, refreshActiveTags } = require("../services/tagMonitor");
const { getCachedOrFetch, refreshStaticData } = require("../services/staticDataCache");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, getTagMetadata } = require("../services/assetFilter");

const router = express.Router();

// ASSET records are not RTLS tags for this application.
function isAsset(item) {
  const usageType = item?.usage_type ?? item?.usageType ?? item?.usage?.type;
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function filterAssets(data) {
  // UNAI can wrap the actual tag array several levels deep (for example
  // { result: { data: [...] } }). The old implementation only checked the
  // first level, which is why ASSET records could still reach the frontend.
  if (Array.isArray(data)) {
    return data
      .filter((item) => !isAsset(item))
      .map((item) => filterAssets(item));
  }

  if (!data || typeof data !== "object") return data;

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = Array.isArray(value) || (value && typeof value === "object")
      ? filterAssets(value)
      : value;
  }
  return result;
}

function countRecords(data) {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return 0;
  return Object.values(data).reduce((total, value) => {
    return total + (Array.isArray(value) || (value && typeof value === "object")
      ? countRecords(value)
      : 0);
  }, 0);
}

function countAssets(data) {
  if (Array.isArray(data)) {
    return data.reduce((total, item) =>
      total + (isAsset(item) ? 1 : countAssets(item)), 0);
  }
  if (!data || typeof data !== "object") return 0;
  return Object.values(data).reduce((total, value) =>
    total + (Array.isArray(value) || (value && typeof value === "object")
      ? countAssets(value)
      : 0), 0);
}

router.get("/health", (req, res) => {
  res.json({ ok: true, service: "unai-backend" });
});

// Token generation is lazy: it happens only when the frontend explicitly
// requests it, never during backend startup.
router.post("/auth/token", async (req, res) => {
  try {
    await generateAccessToken();
    return res.json({ ok: true, message: "UNAI access token generated" });
  } catch (error) {
    console.error("/api/auth/token error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Failed to generate UNAI access token",
      details: error.body || undefined,
    });
  }
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
// Anchors are static infrastructure data for the map. Cache them in the same
// MongoDB StaticData collection so opening Home does not hit UNAI on every page load.
cachedProxyGet("/anchor", "anchor", "APIANCHOR_URL", "Failed to get anchors");

// UNAI /tag does not appear to expose a reliable server-side usage_type filter.
// Therefore the backend fetches the endpoint once, immediately removes ASSET
// records, and only then returns the result to the frontend.
router.get("/tag", async (req, res) => {
  try {
    // Tag metadata is shared with the Asset denylist service and cached for
    // several minutes. This endpoint must not call UNAI independently on every
    // Building/Tag History page load.
    const data = await getTagMetadata();

    // The normal /api/tag response never exposes ASSET records. For the
    // realtime denylist, the frontend can ask this same, already-deployed
    // endpoint for only the Asset IDs. This avoids depending on a separate
    // /api/tag-asset-ids route that may not exist on an older Render deploy.
    if (String(req.query?.mode || "").toLowerCase() === "asset-ids") {
      const assetIds = [];

      function collectAssetIds(value) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(collectAssetIds);
          return;
        }
        if (isAsset(value)) {
          const id = value.tagId ?? value.tag_id ?? value.tagID ?? value.id;
          if (id !== undefined && id !== null) assetIds.push(String(id));
        }
        Object.values(value).forEach((child) => {
          if (child && typeof child === "object") collectAssetIds(child);
        });
      }

      collectAssetIds(data);
      const uniqueIds = [...new Set(assetIds)];
      console.log(`[UNAI TAG] Asset IDs requested: ${uniqueIds.length}`);
      return res.json({ assetTagIds: uniqueIds });
    }

    const filtered = filterAssets(data);

    const totalRecords = countRecords(data);
    const assetRecords = countAssets(data);
    const returnedRecords = countRecords(filtered);

    console.log(
      `[UNAI TAG] total=${totalRecords}, ` +
      `excluded_asset=${assetRecords}, ` +
      `returned=${returnedRecords}`
    );

    return res.json(filtered);
  } catch (error) {
    console.error("/api/tag error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Server error",
      details: error.body || undefined,
    });
  }
});

// Backward-compatible Asset ID endpoint. Keep it for clients that already
// use it, but new frontend code uses GET /api/tag?mode=asset-ids so Render
// deployments only need the existing /api/tag route.
router.get("/tag-asset-ids", async (req, res) => {
  try {
    const data = await getTagMetadata();
    const assetIds = [];

    function collect(value) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (isAsset(value)) {
        const id = value.tagId ?? value.tag_id ?? value.tagID ?? value.id;
        if (id !== undefined && id !== null) assetIds.push(String(id));
      }
      Object.values(value).forEach((child) => {
        if (child && typeof child === "object") collect(child);
      });
    }

    collect(data);
    const uniqueIds = [...new Set(assetIds)];
    console.log(`[UNAI TAG] Asset denylist endpoint: ${uniqueIds.length} Asset ID(s)`);
    return res.json({ assetTagIds: uniqueIds });
  } catch (error) {
    console.error("/api/tag-asset-ids error:", error);
    return res.status(error.status || 500).json({
      error: error.message || "Failed to get Asset tag IDs",
      details: error.body || undefined,
    });
  }
});

// Home-page tag data comes from MongoDB. Existing ASSET events are excluded
// before grouping, so an old Asset event can never become the latest tag.
router.get("/db-tags", async (req, res) => {
  try {
    const timeoutSeconds = Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10;
    const timeoutDate = new Date(Date.now() - timeoutSeconds * 1000);

    const assetTagIds = await getAssetTagIds();
    const match = {
      isAsset: { $ne: true },
      $nor: [
        { "rawData.usage_type": { $regex: /^asset$/i } },
        { "rawData.usageType": { $regex: /^asset$/i } },
        { "rawData.usage.type": { $regex: /^asset$/i } },
      ],
    };
    if (assetTagIds.size > 0) {
      match.tagId = { $nin: [...assetTagIds] };
    }

    const latest = await TagLatest.find(match)
      .select({
        _id: 0,
        tagId: 1,
        tagName: 1,
        buildingId: 1,
        floorId: 1,
        groupId: 1,
        groupName: 1,
        x: 1,
        y: 1,
        z: 1,
        timestamp: 1,
      })
      .sort({ timestamp: -1 })
      .lean();

    const tags = latest.map((event) => ({
      id: event.tagId,
      tagId: event.tagId,
      name: event.tagName || `Tag ${event.tagId}`,
      tagName: event.tagName,
      buildingId: event.buildingId,
      floorId: event.floorId,
      groupId: event.groupId,
      groupName: event.groupName,
      x: event.x,
      y: event.y,
      z: event.z,
      lastSeen: event.timestamp,
      status: event.timestamp >= timeoutDate ? 1 : 0,
      statusText: event.timestamp >= timeoutDate ? "ONLINE" : "OFFLINE",
    }));

    return res.json(tags);
  } catch (error) {
    console.error("/api/db-tags error:", error);
    return res.status(500).json({
      error: "Failed to load tags from MongoDB",
      details: error.message,
    });
  }
});

cachedProxyGet("/zone", "zone", "APIZONE_URL", "Failed to get zones");
cachedProxyGet("/v1/get_all_place", "place", "APIPLACE_URL", "Failed to get places");
cachedProxyGet("/v1/get_all_building", "building", "APIBUILDING_URL", "Failed to get buildings");

router.get("/socket-status", (req, res) => {
  try {
    const { getStatus } = require("../services/unaiSocketManager");
    return res.json({ ok: true, ...getStatus() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

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

router.use("/tag-events", tagEventsRouter);
router.use("/admin", adminRouter);

router.get("/active-tags", async (req, res) => {
  try {
    await refreshActiveTags();
    const tags = getActiveTags({
      buildingId: req.query.buildingId,
      floorId: req.query.floorId,
    });
    return res.json({
      ok: true,
      timeoutSeconds: Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10,
      tags,
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
