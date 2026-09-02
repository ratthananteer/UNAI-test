// ZONE DEFINITION MODEL:
// Optional normalized representation for zone configuration. The current
// application still reads zones through StaticData so existing UNAI sync and
// API responses remain compatible.

const mongoose = require("mongoose");

const zoneSchema = new mongoose.Schema(
  {
    zoneId: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    polygon: { type: [[Number]], required: true },
    color: { type: String, default: "#8b5cf6" },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "zones" },
);

zoneSchema.index({ buildingId: 1, floorId: 1 });
zoneSchema.index({ enabled: 1, floorId: 1 });

module.exports = mongoose.models.Zone || mongoose.model("Zone", zoneSchema);
