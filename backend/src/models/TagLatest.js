// LATEST TAG SNAPSHOT MODEL:
// Keeps one MongoDB document per tag for fast active-tag/status queries.
// TagEvent remains the append-only history collection; this model prevents
// the monitor from repeatedly aggregating the entire history collection.

const mongoose = require("mongoose");

const tagLatestSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true, unique: true },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    groupId: { type: mongoose.Schema.Types.Mixed, default: null },
    groupName: { type: String, default: null },
    tagName: { type: String, default: null },
    status: { type: String, default: "ALIVE" },
    movementStatus: { type: String, default: "UNKNOWN" },
    isAsset: { type: Boolean, default: false },
    x: { type: Number, default: null },
    y: { type: Number, default: null },
    z: { type: Number, default: null },
    timestamp: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "tag_latest" },
);

tagLatestSchema.index({ floorId: 1, timestamp: -1 });
tagLatestSchema.index({ buildingId: 1, floorId: 1, timestamp: -1 });

tagLatestSchema.index({ isAsset: 1, timestamp: -1 });

module.exports = mongoose.models.TagLatest || mongoose.model("TagLatest", tagLatestSchema);
