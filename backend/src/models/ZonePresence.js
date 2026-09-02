// ZONE PRESENCE READ MODEL:
// Keeps the current inside/outside state for each tag/zone pair so
// geofencing checks do not need to replay the entire history collection.

const mongoose = require("mongoose");

const zonePresenceSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true },
    zoneId: { type: String, required: true },
    zoneName: { type: String, default: null },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    status: { type: String, enum: ["INSIDE", "OUTSIDE"], default: "OUTSIDE" },
    enteredAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: Date.now },
    lastX: { type: Number, default: null },
    lastY: { type: Number, default: null },
  },
  { timestamps: true, collection: "zone_presence" },
);

zonePresenceSchema.index({ tagId: 1, zoneId: 1 }, { unique: true });
zonePresenceSchema.index({ buildingId: 1, floorId: 1, status: 1 });
zonePresenceSchema.index({ zoneId: 1, status: 1, lastSeenAt: -1 });

module.exports = mongoose.models.ZonePresence || mongoose.model("ZonePresence", zonePresenceSchema);
