// STATIC DATA CACHE SERVICE:
// Keeps places/buildings/floors/zones in MongoDB.
// It normalizes API response shapes, identifies records by external ID,
// hashes each record to detect changes, and supports both cache-first reads
// and explicit refresh/synchronization from the UNAI API.

const crypto = require("crypto");
const StaticData = require("../models/StaticData");
const { fetchFromApi } = require("./unaiApi");

function hashData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["data", "items", "results", "places", "buildings", "floors", "zones"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function idOf(item) {
  if (!item || typeof item !== "object") return undefined;
  const id = item.id ?? item.place_id ?? item.building_id ?? item.floor_id ?? item.zone_id;
  return id === undefined || id === null ? undefined : String(id);
}

async function syncType(type, apiPath) {
  const remote = asArray(await fetchFromApi(apiPath, `Failed to get ${type}`));
  let inserted = 0;
  let updated = 0;

  const normalized = remote
    .map((item) => ({ item, external_id: idOf(item) }))
    .filter(({ external_id }) => external_id);

  if (!normalized.length) {
    console.log(`[StaticData] ${type}: remote=0 valid records`);
    return { remote: remote.length, inserted: 0, updated: 0 };
  }

  // Read existing hashes in one query instead of one findOne per record.
  const existingRows = await StaticData.find({
    type,
    external_id: { $in: normalized.map(({ external_id }) => external_id) },
  })
    .select({ external_id: 1, data_hash: 1 })
    .lean();
  const existingById = new Map(existingRows.map((row) => [row.external_id, row.data_hash]));

  const now = new Date();
  const operations = [];
  for (const { item, external_id } of normalized) {
    const data_hash = hashData(item);
    const previousHash = existingById.get(external_id);
    if (previousHash === data_hash) continue;

    operations.push({
      updateOne: {
        filter: { type, external_id },
        update: { $set: { type, external_id, data: item, data_hash, synced_at: now } },
        upsert: true,
      },
    });

    if (previousHash === undefined) inserted += 1;
    else updated += 1;
  }

  if (operations.length) await StaticData.bulkWrite(operations, { ordered: false });

  console.log(`[StaticData] ${type}: remote=${remote.length}, inserted=${inserted}, updated=${updated}`);
  return { remote: remote.length, inserted, updated };
}

async function syncStaticData() {
  const config = {
    place: ["APIPLACE_URL", "Failed to get places"],
    building: ["APIBUILDING_URL", "Failed to get buildings"],
    floor: ["APIFLOOR_URL", "Failed to get floors"],
    zone: ["APIZONE_URL", "Failed to get zones"],
  };

  const results = {};
  for (const [type, [envName, errorMessage]] of Object.entries(config)) {
    results[type] = await refreshStaticData(type, () =>
      fetchFromApi(process.env[envName], errorMessage),
    );
  }
  return results;
}

async function getCached(type) {
  const rows = await StaticData.find({ type })
    .select({ _id: 0, data: 1 })
    .sort({ external_id: 1 })
    .lean();
  return rows.map((row) => row.data);
}

async function getCachedOrFetch(type, fetcher) {
  console.log(`[StaticData] ${type}: checking MongoDB cache...`);
  const cached = await getCached(type);

  if (cached.length > 0) {
    console.log(`[WEB DATA] ${type}: MongoDB cache HIT (${cached.length} records)`);
    return cached;
  }

  console.log(`[StaticData] ${type}: MongoDB cache MISS; fetching from UNAI...`);
  const remote = asArray(await fetcher());
  let inserted = 0;

  const operations = remote
    .map((item) => {
      const external_id = idOf(item);
      if (!external_id) return null;
      return {
        updateOne: {
          filter: { type, external_id },
          update: {
            $set: {
              type,
              external_id,
              data: item,
              data_hash: hashData(item),
              synced_at: new Date(),
            },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);

  if (operations.length) {
    const result = await StaticData.bulkWrite(operations, { ordered: false });
    inserted = (result.upsertedCount ?? 0);
  }

  console.log(`[StaticData] ${type}: fetched=${remote.length}, inserted=${inserted}`);
  return remote;
}

async function refreshStaticData(type, fetcher) {
  console.log(`[StaticData] ${type}: manual sync started`);
  const remote = asArray(await fetcher());
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const normalized = remote
    .map((item) => ({ item, external_id: idOf(item) }))
    .filter(({ external_id }) => external_id);

  const existingRows = normalized.length
    ? await StaticData.find({
        type,
        external_id: { $in: normalized.map(({ external_id }) => external_id) },
      })
        .select({ external_id: 1, data_hash: 1 })
        .lean()
    : [];
  const existingById = new Map(existingRows.map((row) => [row.external_id, row.data_hash]));
  const now = new Date();
  const operations = [];

  for (const { item, external_id } of normalized) {
    const data_hash = hashData(item);
    const previousHash = existingById.get(external_id);

    if (previousHash === data_hash) {
      unchanged += 1;
      continue;
    }

    operations.push({
      updateOne: {
        filter: { type, external_id },
        update: { $set: { type, external_id, data: item, data_hash, synced_at: now } },
        upsert: true,
      },
    });

    if (previousHash === undefined) inserted += 1;
    else updated += 1;
  }

  if (operations.length) await StaticData.bulkWrite(operations, { ordered: false });

  console.log(`[StaticData] ${type}: remote=${remote.length}, inserted=${inserted}, updated=${updated}, unchanged=${unchanged}`);
  return { remote: remote.length, inserted, updated, unchanged };
}

module.exports = { getCached, getCachedOrFetch, refreshStaticData, syncStaticData };
