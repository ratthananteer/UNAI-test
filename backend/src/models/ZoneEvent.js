// GEOFENCE EVENT MODEL:
// Stores only zone transitions (ENTER / EXIT), not every position update.
// This keeps the geofencing history small and useful for alerts/auditing.

const mongoose = require("mongoose");

const zoneEventSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true },
    zoneId: { type: String, required: true },
    zoneName: { type: String, default: null },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    event: { type: String, enum: ["ENTER", "EXIT"], required: true },
    x: { type: Number, default: null },
    y: { type: Number, default: null },
    timestamp: { type: Date, required: true },
  },
  { timestamps: true, collection: "zone_events" },
);

zoneEventSchema.index({ tagId: 1, timestamp: -1 });
zoneEventSchema.index({ zoneId: 1, timestamp: -1 });
zoneEventSchema.index({ buildingId: 1, floorId: 1, timestamp: -1 });

module.exports = mongoose.models.ZoneEvent || mongoose.model("ZoneEvent", zoneEventSchema);
