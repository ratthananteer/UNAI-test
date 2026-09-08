const mongoose = require("mongoose");

// APPEND-ONLY RULE-BASED ANOMALY HISTORY.
// Kept separate from TagEvent so existing history/playback queries remain
// backwards compatible and high-write location records stay lightweight.
const anomalyEventSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    groupId: { type: mongoose.Schema.Types.Mixed, default: null },
    groupName: { type: String, default: null },
    tagName: { type: String, default: null },

    rule: {
      type: String,
      required: true,
      enum: [
        "SPEED_TOO_HIGH",
        "SUDDEN_POSITION_JUMP",
        "WRONG_ZONE",
        "RESTRICTED_ZONE",
        "DWELL_TIME",
        "TAG_STALE",
      ],
    },
    severity: {
      type: String,
      required: true,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    },
    status: {
      type: String,
      required: true,
      enum: ["OPEN", "RESOLVED"],
      default: "OPEN",
    },

    message: { type: String, required: true },
    value: { type: Number, default: null },
    threshold: { type: Number, default: null },
    unit: { type: String, default: null },
    zoneId: { type: String, default: null },
    zoneName: { type: String, default: null },

    x: { type: Number, default: null },
    y: { type: Number, default: null },
    z: { type: Number, default: null },
    previousX: { type: Number, default: null },
    previousY: { type: Number, default: null },
    previousZ: { type: Number, default: null },
    previousTimestamp: { type: Date, default: null },
    timestamp: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },

    // Deterministic fingerprint + rule cooldown prevent duplicate anomalies
    // when the same socket packet is observed by multiple code paths.
    eventKey: { type: String, required: true, unique: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: "anomaly_events" },
);

anomalyEventSchema.index({ tagId: 1, timestamp: -1 });
anomalyEventSchema.index({ rule: 1, status: 1, timestamp: -1 });
anomalyEventSchema.index({ buildingId: 1, floorId: 1, timestamp: -1 });
anomalyEventSchema.index({ severity: 1, timestamp: -1 });
// Match the location-event retention policy unless explicitly overridden.
anomalyEventSchema.index(
  { receivedAt: 1 },
  {
    expireAfterSeconds:
      (Number(process.env.ANOMALY_EVENT_TTL_SECONDS) ||
        Number(process.env.TAG_EVENT_TTL_SECONDS) ||
        30 * 24 * 60 * 60),
  },
);

module.exports = mongoose.models.AnomalyEvent || mongoose.model("AnomalyEvent", anomalyEventSchema);
