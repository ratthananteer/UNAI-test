const express = require("express");
const TagEvent = require("../models/TagEvent");
ADMIN_CLEANUP_SECRET = 12345
const router = express.Router();
const CLEANUP_MINUTES = 30;
function authorizeCleanup(req, res) {
  const configuredSecret = String(process.env.ADMIN_CLEANUP_SECRET || "");

  if (!configuredSecret) {
    res.status(503).json({
      error:
        "Admin cleanup is not configured. Set ADMIN_CLEANUP_SECRET on the backend.",
    });
    return false;
  }

  const suppliedSecret = String(req.get("x-admin-cleanup-secret") || "");
  if (!suppliedSecret || suppliedSecret !== configuredSecret) {
    res.status(403).json({ error: "Invalid admin cleanup secret" });
    return false;
  }

  return true;
}

function getCutoff() {
  return new Date(Date.now() - CLEANUP_MINUTES * 60 * 1000);
}

router.get("/tag-events/cleanup-preview", async (req, res) => {
  try {
    if (!authorizeCleanup(req, res)) return;

    const cutoff = getCutoff();
    const eligible = await TagEvent.countDocuments({
      receivedAt: { $lt: cutoff },
    });

    return res.json({
      ok: true,
      retentionMinutes: CLEANUP_MINUTES,
      cutoff: cutoff.toISOString(),
      eligibleCount: eligible,
    });
  } catch (error) {
    console.error("[Admin Cleanup] preview failed:", error);
    return res.status(500).json({
      error: "Failed to preview TagEvent cleanup",
      details: error.message,
    });
  }
});

// Delete only TagEvent history older than 30 minutes based on receivedAt.
// TagLatest is intentionally preserved because it is the current-tag read model.
router.post("/tag-events/cleanup", async (req, res) => {
  try {
    if (!authorizeCleanup(req, res)) return;

    const cutoff = getCutoff();
    const result = await TagEvent.deleteMany({
      receivedAt: { $lt: cutoff },
    });

    console.log(
      `[Admin Cleanup] Deleted ${result.deletedCount} TagEvent record(s) older than ${CLEANUP_MINUTES} minutes`,
    );

    return res.json({
      ok: true,
      retentionMinutes: CLEANUP_MINUTES,
      cutoff: cutoff.toISOString(),
      deletedCount: result.deletedCount,
      collection: "TagEvent",
      tagLatestPreserved: true,
    });
  } catch (error) {
    console.error("[Admin Cleanup] delete failed:", error);
    return res.status(500).json({
      error: "Failed to cleanup TagEvent history",
      details: error.message,
    });
  }
});

module.exports = router;

