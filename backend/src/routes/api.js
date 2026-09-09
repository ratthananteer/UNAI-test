// MAIN API ROUTES:
// Static data is MongoDB cache-first; live UNAI endpoints are proxied through
// the authenticated UNAI API service. Tag history/current state use MongoDB.

const express = require("express");
const { fetchFromApi, generateSocketTopic } = require("../services/unaiApi");
const { generateAccessToken } = require("../services/unaiAuth");
const tagEventsRouter = require("./tagEvents");
const adminRouter = require("./admin");
const analyticsRouter = require("./analytics");
const anomaliesRouter = require("./anomalies");
const { getActiveTags, refreshActiveTags } = require("../services/tagMonitor");
const { getCached, getCachedOrFetch, refreshStaticData } = require("../services/staticDataCache");
const TagLatest = require("../models/TagLatest");
const { getAssetTagIds, getTagMetadata } = require("../services/assetFilter");
const { start: startRealtimeCollector, subscribeRealtime, getStatus: getRealtimeStatus } = require("../services/unaiSocketManager");
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

// Historical tag events, rule-based anomaly history, and admin cleanup.
router.use("/tag-events", tagEventsRouter);
router.use("/anomalies", anomaliesRouter);
router.use("/admin", adminRequired(), adminRouter);

// Backend-owned realtime stream.
//
// The browser connects to this endpoint, never to UNAI directly. The first
// subscriber lazily starts one shared UNAI collector for all floors already
// present in MongoDB. Additional Home/Building tabs only become SSE clients of
// this backend stream; they do not create another UNAI socket or token request.
let realtimeCollectorPromise = null;
const realtimeClients = new Set();
let realtimeHeartbeat = null;

function floorRecordsFromCache(rows) {
  const floors = [];
  const seen = new Set();

  for (const row of rows || []) {
    const floor = row?.data ?? row;
    if (!floor || typeof floor !== "object") continue;
    const floorId = floor.id ?? floor.floor_id ?? floor.floorId ?? floor.floorID ?? floor.floor;
    if (floorId == null || typeof floorId === "object") continue;
    const key = String(floorId);
    if (seen.has(key)) continue;
    seen.add(key);

    const building = floor.building;
    floors.push({
      id: key,
      buildingId:
        floor.building_id ??
        floor.buildingId ??
        floor.buildingID ??
        (building && typeof building === "object" ? building.id ?? building.building_id ?? building.buildingId : null),
    });
  }

  return floors;
}

async function ensureRealtimeCollector() {
  if (getRealtimeStatus().started) return;
  if (realtimeCollectorPromise) return realtimeCollectorPromise;

  realtimeCollectorPromise = (async () => {
    const StaticData = require("../models/StaticData");
    const rows = await StaticData.find({ type: "floor" })
      .select({ _id: 0, data: 1 })
      .sort({ external_id: 1 })
      .lean();
    const floors = floorRecordsFromCache(rows);

    if (!floors.length) {
      throw new Error("No floor configuration is available in MongoDB; realtime collector was not started.");
    }

    console.log(`[Realtime] Starting shared UNAI collector for ${floors.length} floor(s)`);
    await startRealtimeCollector({ floors });
  })().finally(() => {
    realtimeCollectorPromise = null;
  });

  return realtimeCollectorPromise;
}

function ensureRealtimeHeartbeat() {
  if (realtimeHeartbeat) return;
  realtimeHeartbeat = setInterval(() => {
    const message = `event: heartbeat\\ndata: ${JSON.stringify({
      timestamp: new Date().toISOString(),
      clients: realtimeClients.size,
      collector: getRealtimeStatus(),
    })}\\n\\n`;
    for (const client of realtimeClients) {
      try {
        client.write(message);
      } catch {
        realtimeClients.delete(client);
      }
    }

    if (realtimeClients.size === 0) {
      clearInterval(realtimeHeartbeat);
      realtimeHeartbeat = null;
    }
  }, 15_000);
}

router.get("/realtime", async (req, res) => {
  try {
    await ensureRealtimeCollector();
  } catch (error) {
    console.error("[Realtime] collector start failed:", error.message);
    return res.status(503).json({
      error: "Realtime collector is unavailable",
      details: error.message,
    });
  }

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  // Tell EventSource to wait 30s before reconnecting if the backend stream is
  // temporarily unavailable. This avoids a browser reconnect storm.
  res.write(`retry: 30000\\n\\n`);

  const client = res;
  realtimeClients.add(client);
  ensureRealtimeHeartbeat();

  const send = (eventName, payload) => {
    if (client.writableEnded || client.destroyed) return;
    try {
      client.write(`event: ${eventName}\\ndata: ${JSON.stringify(payload)}\\n\\n`);
    } catch {
      realtimeClients.delete(client);
    }
  };

  const unsubscribe = subscribeRealtime((records) => {
    send("tags", {
      timestamp: new Date().toISOString(),
      tags: records,
    });
  });

  // Immediately give the page a MongoDB snapshot. The following SSE events are
  // live UNAI updates from the same backend collector.
  try {
    const snapshot = await getDbTags();
    send("snapshot", {
      timestamp: new Date().toISOString(),
      tags: snapshot,
    });
  } catch (error) {
    send("error", { message: "Failed to load realtime snapshot" });
  }

  req.on("close", () => {
    unsubscribe();
    realtimeClients.delete(client);
    if (realtimeClients.size === 0 && realtimeHeartbeat) {
      clearInterval(realtimeHeartbeat);
      realtimeHeartbeat = null;
    }
  });

  return undefined;
});

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
    // Zone geometry is static configuration. Keep the normal Building/Home
    // read path MongoDB-only so opening or refreshing a page can never trigger
    // an upstream UNAI /zone request and consume the rate limit.
    const cached = await getCached("zone");

    const filtered = cached.filter((zone) => {
      if (req.query.buildingId != null) {
        const buildingId = zone?.building_id ?? zone?.buildingId;
        if (buildingId != null && String(buildingId) !== String(req.query.buildingId)) return false;
      }
      if (req.query.floorId != null) {
        const floorId = zone?.floor_id ?? zone?.floorId ?? zone?.floorID;
        if (floorId != null && String(floorId) !== String(req.query.floorId)) return false;
      }
      return true;
    });

    if (cached.length === 0) {
      console.warn("[API] /zone MongoDB cache is empty; returning [] without calling UNAI");
    } else {
      console.log(`[API] /zone MongoDB cache HIT (${cached.length} records)`);
    }

    res.set("Cache-Control", "private, max-age=30, stale-while-revalidate=300");
    return res.status(200).json(filtered);
  } catch (error) {
    // Zone is optional presentation/configuration data. A MongoDB read failure
    // must not turn the Building page into a request/retry loop.
    console.error("[API] /zone MongoDB read failed:", error.message);
    return res.status(200).json([]);
  }
});

router.get("/anchor", async (req, res) => {
  try {
    // IMPORTANT: Anchor data is static configuration. Never make the Home or
    // Building page call the upstream UNAI anchor endpoint on every page load.
    // A cache miss used to trigger an immediate UNAI request, and repeated
    // refreshes could therefore produce HTTP 429. MongoDB is now the only
    // source used by this read endpoint.
    //
    // To populate/update the cache, use the existing POST /api/refresh-static
    // operational endpoint when the upstream API is available. This keeps the
    // normal read path completely isolated from the UNAI rate limit.
    const cached = await getCached("anchor");

    const filtered = cached.filter((anchor) => {
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

    if (cached.length === 0) {
      console.warn("[API] /anchor MongoDB cache is empty; returning [] without calling UNAI");
    } else {
      console.log(`[API] /anchor MongoDB cache HIT (${cached.length} records)`);
    }

    return res.status(200).json(filtered);
  } catch (error) {
    // Anchor is non-critical static infrastructure for Home. Never turn a
    // MongoDB read failure into an upstream retry storm or an HTTP 429.
    console.error("[API] /anchor MongoDB read failed:", error.message);
    return res.status(200).json([]);
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
