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
  const remote = asArray(await unaiGet(apiPath));
  let inserted = 0;
  let updated = 0;

  for (const item of remote) {
    const external_id = idOf(item);
    if (!external_id) continue;

    const data_hash = hashData(item);
    const existing = await StaticData.findOne({ type, external_id }).lean();

    if (existing && existing.data_hash === data_hash) {
      console.log(`[StaticData] ${type} ${external_id}: unchanged, using MongoDB`);
      continue;
    }

    await StaticData.updateOne(
      { type, external_id },
      { $set: { type, external_id, data: item, data_hash, synced_at: new Date() } },
      { upsert: true },
    );

    if (existing) {
      updated += 1;
      console.log(`[StaticData] ${type} ${external_id}: UPDATED in MongoDB`);
    } else {
      inserted += 1;
      console.log(`[StaticData] ${type} ${external_id}: INSERTED into MongoDB`);
    }
  }

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
  const rows = await StaticData.find({ type }).sort({ external_id: 1 }).lean();
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

  for (const item of remote) {
    const external_id = idOf(item);
    if (!external_id) continue;
    await StaticData.updateOne(
      { type, external_id },
      { $set: { type, external_id, data: item, data_hash: hashData(item), synced_at: new Date() } },
      { upsert: true },
    );
    inserted += 1;
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

  for (const item of remote) {
    const external_id = idOf(item);
    if (!external_id) continue;
    const data_hash = hashData(item);
    const existing = await StaticData.findOne({ type, external_id }).lean();

    if (existing && existing.data_hash === data_hash) {
      unchanged += 1;
      continue;
    }

    await StaticData.updateOne(
      { type, external_id },
      { $set: { type, external_id, data: item, data_hash, synced_at: new Date() } },
      { upsert: true },
    );

    if (existing) updated += 1;
    else inserted += 1;
  }

  console.log(`[StaticData] ${type}: remote=${remote.length}, inserted=${inserted}, updated=${updated}, unchanged=${unchanged}`);
  return { remote: remote.length, inserted, updated, unchanged };
}

module.exports = { getCachedOrFetch, refreshStaticData, syncStaticData };
