// STATIC DATA MODEL:
// Stores relatively stable RTLS configuration such as places, buildings,
// floors, and zones in MongoDB so the frontend can read a local cache.
// `data` keeps the original API object; `data_hash` detects whether it changed.

const mongoose = require("mongoose");

const StaticDataSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["place", "building", "floor", "zone", "anchor"],
    },
    external_id: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    data_hash: { type: String, required: true },
    synced_at: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "static_data" },
);

StaticDataSchema.index({ type: 1, external_id: 1 }, { unique: true });

module.exports = mongoose.models.StaticData || mongoose.model("StaticData", StaticDataSchema);
