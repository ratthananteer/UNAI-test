const express = require("express");
const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");
const User = require("../models/User");
const { hashPassword, normalizeUsername, validateCredentials } = require("../services/auth");
const { getAssetTagIds, getTagMetadata } = require("../services/assetFilter");

const router = express.Router();
const CLEANUP_MINUTES = 30;

function authorizeCleanup(req, res) {
  const configuredSecret = String(process.env.ADMIN_CLEANUP_SECRET || "");
  if (!configuredSecret) {
    res.status(503).json({ error: "Admin cleanup is not configured. Set ADMIN_CLEANUP_SECRET on the backend." });
    return false;
  }
  const suppliedSecret = String(req.get("x-admin-cleanup-secret") || "");
  if (!suppliedSecret || suppliedSecret !== configuredSecret) {
    res.status(403).json({ error: "Invalid admin cleanup secret" });
    return false;
  }
  return true;
}
function getCutoff() { return new Date(Date.now() - CLEANUP_MINUTES * 60 * 1000); }
function publicUser(user) { return { id: String(user._id || user.id), username: user.username, role: user.role, lastLoginAt: user.lastLoginAt || null, createdAt: user.createdAt || null, updatedAt: user.updatedAt || null }; }
function safeLimit(value, fallback = 100) { const n = Number(value); return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 500) : fallback; }
function safeString(value) { return String(value ?? "").trim(); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------- User management ----------
router.get("/users", async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit);
    const search = safeString(req.query.search);
    const filter = search ? { username: { $regex: escapeRegex(search), $options: "i" } } : {};
    const users = await User.find(filter).select("username role lastLoginAt createdAt updatedAt").sort({ username: 1 }).limit(limit).lean();
    return res.json({ items: users.map(publicUser), limit });
  } catch (error) { console.error("[Admin Users] list failed:", error); return res.status(500).json({ error: "Failed to load users", details: error.message }); }
});

router.post("/users", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    const role = req.body?.role === "admin" ? "admin" : "user";
    const validationError = validateCredentials(username, password);
    if (validationError) return res.status(400).json({ error: validationError });
    if (await User.exists({ username })) return res.status(409).json({ error: "Username is already registered." });
    const user = await User.create({ username, password: hashPassword(password), role });
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "Username is already registered." });
    console.error("[Admin Users] create failed:", error); return res.status(500).json({ error: "Failed to create user", details: error.message });
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("username role sessionVersion lastLoginAt createdAt updatedAt");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (req.body?.role !== undefined) {
      if (req.body.role !== "user" && req.body.role !== "admin") return res.status(400).json({ error: "Invalid role" });
      if (String(user._id) === String(req.user?.id) && req.body.role !== "admin") return res.status(400).json({ error: "You cannot remove your own admin role." });
      user.role = req.body.role;
    }
    if (req.body?.password !== undefined) {
      const validationError = validateCredentials(user.username, req.body.password);
      if (validationError) return res.status(400).json({ error: validationError });
      user.password = hashPassword(req.body.password);
      user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    }
    await user.save();
    return res.json({ user: publicUser(user) });
  } catch (error) { console.error("[Admin Users] update failed:", error); return res.status(500).json({ error: "Failed to update user", details: error.message }); }
});

router.delete("/users/:id", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user?.id)) return res.status(400).json({ error: "You cannot delete your own account." });
    const user = await User.findById(req.params.id).select("_id");
    if (!user) return res.status(404).json({ error: "User not found" });
    await User.deleteOne({ _id: user._id });
    return res.json({ ok: true, id: String(user._id) });
  } catch (error) { console.error("[Admin Users] delete failed:", error); return res.status(500).json({ error: "Failed to delete user", details: error.message }); }
});

// ---------- Tag management/read model ----------
router.get("/tags", async (req, res) => {
  try {
    const assetTagIds = await getAssetTagIds();
    const filter = { isAsset: { $ne: true } };
    if (assetTagIds.size) filter.tagId = { $nin: [...assetTagIds] };
    if (req.query.buildingId) filter.buildingId = String(req.query.buildingId);
    if (req.query.floorId) filter.floorId = String(req.query.floorId);
    if (req.query.groupId) filter.groupId = String(req.query.groupId);
    const search = safeString(req.query.search);
    if (search) {
      const escaped = escapeRegex(search);
      filter.$or = [{ tagId: { $regex: escaped, $options: "i" } }, { tagName: { $regex: escaped, $options: "i" } }, { groupName: { $regex: escaped, $options: "i" } }];
    }
    const limit = safeLimit(req.query.limit, 200);
    const timeoutMs = (Number(process.env.TAG_ALIVE_TIMEOUT_SECONDS) || 10) * 1000;
    const now = Date.now();
    const rows = await TagLatest.find(filter).sort({ tagName: 1, tagId: 1 }).limit(limit).lean();
    const items = rows.map((row) => ({ id: String(row.tagId), tagId: String(row.tagId), tagName: row.tagName || null, groupId: row.groupId ?? null, groupName: row.groupName || null, buildingId: row.buildingId || null, floorId: row.floorId || null, x: row.x ?? null, y: row.y ?? null, z: row.z ?? null, status: row.timestamp && now - new Date(row.timestamp).getTime() <= timeoutMs ? "ONLINE" : "OFFLINE", lastSeen: row.timestamp || null, movementStatus: row.movementStatus || "UNKNOWN" }));
    return res.json({ items, limit, assetCount: assetTagIds.size });
  } catch (error) { console.error("[Admin Tags] list failed:", error); return res.status(500).json({ error: "Failed to load tags", details: error.message }); }
});

router.get("/tags/metadata", async (req, res) => {
  try { return res.json({ ok: true, metadata: await getTagMetadata() }); }
  catch (error) { return res.status(500).json({ error: "Failed to load tag metadata", details: error.message }); }
});

// ---------- Existing TagEvent cleanup ----------
router.get("/tag-events/cleanup-preview", async (req, res) => {
  try {
    if (!authorizeCleanup(req, res)) return;
    const cutoff = getCutoff();
    const eligible = await TagEvent.countDocuments({ receivedAt: { $lt: cutoff } });
    return res.json({ ok: true, retentionMinutes: CLEANUP_MINUTES, cutoff: cutoff.toISOString(), eligibleCount: eligible });
  } catch (error) { console.error("[Admin Cleanup] preview failed:", error); return res.status(500).json({ error: "Failed to preview TagEvent cleanup", details: error.message }); }
});

router.post("/tag-events/cleanup", async (req, res) => {
  try {
    if (!authorizeCleanup(req, res)) return;
    const cutoff = getCutoff();
    const result = await TagEvent.deleteMany({ receivedAt: { $lt: cutoff } });
    console.log(`[Admin Cleanup] Deleted ${result.deletedCount} TagEvent record(s) older than ${CLEANUP_MINUTES} minutes`);
    return res.json({ ok: true, retentionMinutes: CLEANUP_MINUTES, cutoff: cutoff.toISOString(), deletedCount: result.deletedCount, collection: "TagEvent", tagLatestPreserved: true });
  } catch (error) { console.error("[Admin Cleanup] delete failed:", error); return res.status(500).json({ error: "Failed to cleanup TagEvent history", details: error.message }); }
});

module.exports = router;
