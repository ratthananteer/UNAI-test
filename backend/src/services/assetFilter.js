// ASSET FILTER:
// UNAI Socket location payloads may omit usage_type. The authoritative tag
// metadata endpoint does contain usage_type, so this service builds a short-
// lived denylist of Asset tag IDs and lets all backend paths filter by ID.

const { fetchFromApi } = require("./unaiApi");

let assetTagIdsCache = new Set();
let loadedAt = 0;
const CACHE_MS = 60_000;

function isAsset(value) {
  if (!value || typeof value !== "object") return false;
  const item = value;
  const usageType = item.usage_type ?? item.usageType ?? item.usage?.type;
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function tagIdOf(value) {
  if (!value || typeof value !== "object") return null;
  const id = value.tagId ?? value.tag_id ?? value.tagID ?? value.id;
  return id === undefined || id === null ? null : String(id);
}

function collectAssetTagIds(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetTagIds(item, output));
    return output;
  }

  if (isAsset(value)) {
    const id = tagIdOf(value);
    if (id) output.add(id);
  }

  Object.values(value).forEach((child) => {
    if (child && typeof child === "object") collectAssetTagIds(child, output);
  });

  return output;
}

async function getAssetTagIds(force = false) {
  if (!force && Date.now() - loadedAt < CACHE_MS) {
    return assetTagIdsCache;
  }

  try {
    const data = await fetchFromApi(
      process.env.APITAG_URL,
      "Failed to get tag metadata",
    );
    assetTagIdsCache = collectAssetTagIds(data);
    loadedAt = Date.now();
    console.log(
      `[UNAI TAG] Asset metadata loaded: ${assetTagIdsCache.size} Asset tag(s)`,
    );
  } catch (error) {
    console.error("[UNAI TAG] Failed to refresh Asset metadata:", error.message);
  }

  return assetTagIdsCache;
}

function isAssetOrKnownAsset(value, assetTagIds) {
  if (isAsset(value)) return true;
  const id = tagIdOf(value);
  return Boolean(id && assetTagIds?.has(id));
}

module.exports = {
  isAsset,
  tagIdOf,
  collectAssetTagIds,
  getAssetTagIds,
  isAssetOrKnownAsset,
};
