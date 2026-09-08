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
const authRouter = require("./auth");
const { authRequired, adminRequired } = require("../services/auth");

const router = express.Router();

// Authentication is intentionally separate from the RTLS data routes.
router.use("/auth", authRouter);

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

// The Home page requests a UNAI API access token lazily. This is an internal
// server-to-server credential exchange and must remain public to the browser
// because the browser does not have an app session yet. The actual UNAI
// credentials stay on the backend and are never sent to the browser.
router.post("/auth/token", async (req, res) => {
  try {
    const token = await generateAccessToken();
    return res.json({ access_token: token });
  } catch (error) {
    console.error("/api/auth/token error:", error);
    return res.status(error.status || 500).json({ error: error.message });
  }
});

// Everything below this point is private. The browser authenticates with the
// HttpOnly cookie; JavaScript never receives the app JWT itself.
router.use(authRequired());

// Analytics dashboard.
router.use("/analytics", analyticsRouter);

// Historical tag events and admin cleanup.
router.use("/tag-events", tagEventsRouter);
router.use("/admin", adminRequired(), adminRouter);

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

async function getFloorsResponse(req, res) {
  try {
    // The Building page must never expose an upstream UNAI 404 as its own
    // /api/floors response. MongoDB is the source of truth when it already
    // contains floor configuration; UNAI is only used to populate an empty
    // cache.
    const data = await getCachedOrFetch(
      "floor",
      () => fetchFromApi(process.env.APIFLOOR_URL, "Failed to get floors"),
    );

    const filtered = data.filter((floor) => {
      const buildingId = req.query.buildingId;
      if (buildingId == null) return true;

      const floorBuildingId = floor?.building_id ?? floor?.buildingId;
      if (floorBuildingId != null) return String(floorBuildingId) === String(buildingId);

      const building = floor?.building;
      if (building && typeof building === "object") {
        const nestedId = building.id ?? building.building_id ?? building.buildingId;
        if (nestedId != null) return String(nestedId) === String(buildingId);
      }

      // Preserve legacy/cache records that do not carry a building relation.
      return true;
    });

    return res.status(200).json(filtered);
  } catch (error) {
    console.error("[API] floor source unavailable:", error.message);

    // Always return HTTP 200 for this read-model endpoint. A temporary UNAI
    // 404/5xx should result in an empty/stale floor list, not a failed
    // Building page render.
    try {
      const StaticData = require("../models/StaticData");
      const cached = await StaticData.find({ type: "floor" })
        .select({ _id: 0, data: 1 })
        .sort({ external_id: 1 })
        .lean();

      const data = cached.map((row) => row.data).filter(Boolean);
      return res.status(200).json(data);
    } catch (cacheError) {
      console.error("[API] floor cache fallback error:", cacheError.message);
      return res.status(200).json([]);
    }
  }
}

// Preferred frontend route.
router.get("/floors", getFloorsResponse);

// Compatibility alias for older Building-page builds. Both routes use the
// exact same MongoDB-first implementation, so a stale frontend cannot fall
// through to a missing endpoint and turn a floor read into HTTP 404.
router.get("/v1/get_all_floor", getFloorsResponse);

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
    // Anchors are static configuration, just like floors/zones. Read MongoDB
    // first so a temporary/retired UNAI anchor endpoint cannot make the
    // Building page fail. If the cache is empty, try UNAI once and persist the
    // result through getCachedOrFetch().
    const data = await getCachedOrFetch(
      "anchor",
      () => fetchFromApi(process.env.APIANCHOR_URL, "Failed to get anchors"),
    );

    const filtered = data.filter((anchor) => {
      if (req.query.buildingId != null) {
        const buildingId = anchor?.building_id ?? anchor?.buildingId;
        if (buildingId != null && String(buildingId) !== String(req.query.buildingId)) return false;
      }
      if (req.query.floorId != null) {
        const floorId = anchor?.floor_id ?? anchor?.floorId;
        if (floorId != null && String(floorId) !== String(req.query.floorId)) return false;
      }
      return true;
    });

    return res.json(filtered);
  } catch (error) {
    // A 404 from the upstream anchor endpoint is not a reason to fail the
    // Building page. getCachedOrFetch normally already returned cache data;
    // this final fallback also handles a completely empty cache gracefully.
    console.warn("[API] /anchor upstream unavailable:", error.message);
    return res.json([]);
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

// Manual static-data refresh for operational/admin use.
router.post("/refresh-static", async (req, res) => {
  try {
    const types = ["place", "building", "floor", "zone", "anchor"];
    const results = {};
    for (const type of types) {
      const envNames = {
        place: "APIPLACE_URL",
        building: "APIBUILDING_URL",
        floor: "APIFLOOR_URL",
        zone: "APIZONE_URL",
        anchor: "APIANCHOR_URL",
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
