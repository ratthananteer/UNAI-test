// MAIN API ROUTES:
// Static data is MongoDB cache-first; live UNAI endpoints are proxied through
// the authenticated UNAI API service. Tag history/current state use MongoDB.

const express = require("express");
const { fetchFromApi, generateSocketTopic } = require("../services/unaiApi");
const { generateAccessToken } = require("../services/unaiAuth");
const tagEventsRouter = require("./tagEvents");
const adminRouter = require("./admin");
const analyticsRouter = require("./analytics");
const { getActiveTags, refreshActiveTags } = require("../services/tagMonitor");
const { getCachedOrFetch, refreshStaticData } = require("../services/staticDataCache");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, getTagMetadata } = require("../services/assetFilter");

const router = express.Router();

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["data", "items", "results", ...keys]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function isAsset(item) {
  const usage = item?.usage_type ?? item?.usageType ?? item?.usage?.type;
  return String(usage ?? "").trim().toUpperCase() === "ASSET";
}

const DB_TAGS_CACHE_MS = Math.max(
  5_000,
  Number(process.env.DB_TAGS_CACHE_MS) || 5_000,
);
let dbTagsCache = null;
let dbTagsCacheAt = 0;
let dbTagsRefreshPromise = null;

async function readDbTagsFromMongo() {
  const assetTagIds = await getAssetTagIds();
  const filter = { isAsset: { $ne: true } };
  if (assetTagIds.size) filter.tagId = { $nin: [...assetTagIds] };

  const rows = await TagLatest.find(filter)
    .sort({ tagId: 1 })
    .lean();

  const timeoutMs = (Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10) * 1000;
  const now = Date.now();

  return rows.map((row) => {
    const timestamp = row.timestamp ? new Date(row.timestamp) : null;
    const alive = timestamp && now - timestamp.getTime() <= timeoutMs;
    return {
      ...row,
      id: row.tagId,
      tagId: row.tagId,
      status: alive ? 1 : 0,
      statusText: alive ? "ONLINE" : "OFFLINE",
      lastSeen: timestamp?.toISOString() ?? null,
    };
  });
}

async function getDbTags() {
  const now = Date.now();

  // /db-tags is polled by the Home page. Keep the endpoint cheap even when
  // several browser tabs refresh at the same time. TagLatest is already the
  // MongoDB read model, so a very short server-side cache is sufficient.
  if (dbTagsCache && now - dbTagsCacheAt < DB_TAGS_CACHE_MS) {
    return dbTagsCache;
  }

  // Single-flight: concurrent requests share one MongoDB query instead of
  // creating a burst of identical requests when a page/tab becomes active.
  if (dbTagsRefreshPromise) return dbTagsRefreshPromise;

  dbTagsRefreshPromise = readDbTagsFromMongo()
    .then((tags) => {
      dbTagsCache = tags;
      dbTagsCacheAt = Date.now();
      return tags;
    })
    .finally(() => {
      dbTagsRefreshPromise = null;
    });

  return dbTagsRefreshPromise;
}

// Basic backend health check. Render uses this endpoint as its healthCheckPath.
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "unai-backend", timestamp: new Date().toISOString() });
});

// Analytics dashboard.
router.use("/analytics", analyticsRouter);

// Historical tag events and admin cleanup.
router.use("/tag-events", tagEventsRouter);
router.use("/admin", adminRouter);

// Current tag state from MongoDB TagLatest.
router.get("/db-tags", async (req, res) => {
  try {
    const tags = await getDbTags();
    const filtered = tags.filter((tag) => {
      if (req.query.buildingId && String(tag.buildingId) !== String(req.query.buildingId)) return false;
      if (req.query.floorId && String(tag.floorId) !== String(req.query.floorId)) return false;
      return true;
    });

    // This endpoint is intentionally cache-friendly. The data itself is
    // refreshed by TagMonitor/TagLatest; clients do not need to hammer the
    // backend every few seconds.
    res.set("Cache-Control", "private, max-age=2, stale-while-revalidate=8");
    return res.json(filtered);
  } catch (error) {
    console.error("/api/db-tags error:", error);
    return res.status(500).json({ error: "Failed to load tags from MongoDB", details: error.message });
  }
});

// Active tag status read model.
router.get("/active-tags", async (req, res) => {
  try {
    await refreshActiveTags();
    const tags = getActiveTags({ buildingId: req.query.buildingId, floorId: req.query.floorId });
    return res.json({ ok: true, timeoutSeconds: Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10, tags });
  } catch (error) {
    console.error("/api/active-tags error:", error);
    return res.status(500).json({ error: "Failed to check active tags", details: error.message });
  }
});

// Asset denylist used by frontend/socket consumers.
router.get("/tag-asset-ids", async (req, res) => {
  try {
    const ids = await getAssetTagIds();
    return res.json({ tagIds: [...ids] });
  } catch (error) {
    console.error("/api/tag-asset-ids error:", error);
    return res.status(500).json({ error: "Failed to load Asset tag IDs", details: error.message });
  }
});

// Tag metadata comes from the cached UNAI metadata response. Filter ASSET rows.
router.get("/tag", async (req, res) => {
  try {
    const metadata = await getTagMetadata();
    const tags = asArray(metadata, ["tags"]);
    const assetIds = await getAssetTagIds();
    return res.json(tags.filter((item) => !isAsset(item) && !assetIds.has(String(item?.id ?? item?.tagId ?? item?.tag_id))));
  } catch (error) {
    console.error("/api/tag error:", error);
    return res.status(500).json({ error: "Failed to get tags", details: error.message });
  }
});

// Static configuration: cache-first, UNAI only on cache miss.
router.get("/v1/get_all_place", async (req, res) => {
  try {
    const data = await getCachedOrFetch("place", () => fetchFromApi(process.env.APIPLACE_URL, "Failed to get places"));
    return res.json(data);
  } catch (error) {
    console.error("/api/v1/get_all_place error:", error);
    return res.status(error.status || 500).json({ error: "Failed to get places", details: error.message });
  }
});

router.get("/v1/get_all_building", async (req, res) => {
  try {
    const data = await getCachedOrFetch("building", () => fetchFromApi(process.env.APIBUILDING_URL, "Failed to get buildings"));
    return res.json(data);
  } catch (error) {
    console.error("/api/v1/get_all_building error:", error);
    return res.status(error.status || 500).json({ error: "Failed to get buildings", details: error.message });
  }
});

router.get("/floors", async (req, res) => {
  try {
    const data = await getCachedOrFetch("floor", () => fetchFromApi(process.env.APIFLOOR_URL, "Failed to get floors"));
    return res.json(data);
  } catch (error) {
    console.error("/api/floors error:", error);
    return res.status(error.status || 500).json({ error: "Failed to get floors", details: error.message });
  }
});

router.get("/zone", async (req, res) => {
  try {
    const data = await getCachedOrFetch("zone", () => fetchFromApi(process.env.APIZONE_URL, "Failed to get zones"));
    return res.json(data);
  } catch (error) {
    console.error("/api/zone error:", error);
    return res.status(error.status || 500).json({ error: "Failed to get zones", details: error.message });
  }
});

router.get("/anchor", async (req, res) => {
  try {
    const data = await getCachedOrFetch("anchor", () => fetchFromApi(process.env.APIANCHOR_URL, "Failed to get anchors"));
    return res.json(data);
  } catch (error) {
    console.error("/api/anchor error:", error);
    return res.status(error.status || 500).json({ error: "Failed to get anchors", details: error.message });
  }
});

// Generate per-floor socket credentials. Cached/single-flight in unaiApi.
router.get("/socket-topic", async (req, res) => {
  try {
    const floorID = req.query.floorID ?? req.query.floorId;
    if (floorID === undefined || floorID === null || String(floorID).trim() === "") {
      return res.status(400).json({ error: "floorID is required" });
    }
    const data = await generateSocketTopic(floorID);
    return res.json(data);
  } catch (error) {
    console.error("/api/socket-topic error:", error);
    return res.status(error.status || 500).json({ error: error.message, details: error.body || undefined });
  }
});

// Optional explicit token endpoint for server-side/admin diagnostics. The
// browser does not need to call this for normal Home/Building operation.
router.post("/auth/token", async (req, res) => {
  try {
    const token = await generateAccessToken();
    return res.json({ access_token: token });
  } catch (error) {
    console.error("/api/auth/token error:", error);
    return res.status(error.status || 500).json({ error: error.message });
  }
});

// Manual static-data refresh for operational/admin use.
router.post("/refresh-static", async (req, res) => {
  try {
    const types = ["place", "building", "floor", "zone"];
    const results = {};
    for (const type of types) {
      const envNames = {
        place: "APIPLACE_URL",
        building: "APIBUILDING_URL",
        floor: "APIFLOOR_URL",
        zone: "APIZONE_URL",
      };
      results[type] = await refreshStaticData(type, () =>
        fetchFromApi(process.env[envNames[type]], `Failed to get ${type}`),
      );
    }
    return res.json({ ok: true, results });
  } catch (error) {
    console.error("/api/refresh-static error:", error);
    return res.status(error.status || 500).json({ error: "Failed to refresh static data", details: error.message });
  }
});

module.exports = router;
