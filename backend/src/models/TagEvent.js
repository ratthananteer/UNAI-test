
const mongoose = require("mongoose");

const tagEventSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    groupId: { type: mongoose.Schema.Types.Mixed, default: null },
    groupName: { type: String, default: null },
    tagName: { type: String, default: null },
    event: { type: String, default: "position_update" },
    // Stable fingerprint used to prevent duplicate history writes when more
    // than one frontend subscriber sends the same realtime packet.
    eventKey: { type: String, default: null },
    status: { type: String, default: "ALIVE" },
    movementStatus: { type: String, default: "UNKNOWN" },
    // Denormalized so active/history queries do not need regex scans inside rawData.
    isAsset: { type: Boolean, default: false },
    x: { type: Number, default: null },
    y: { type: Number, default: null },
    z: { type: Number, default: null },
    rawData: { type: mongoose.Schema.Types.Mixed },
    // Time received by our backend. `timestamp` remains the upstream event time.
    receivedAt: { type: Date, default: Date.now },
    timestamp: { type: Date, required: true },
  },
  // TagEvent is append-only history. Mongoose createdAt/updatedAt are
  // redundant because receivedAt is the authoritative ingestion timestamp.
  { timestamps: false }
);

// Query-oriented indexes. Keep the index set small because TagEvent is a
// high-write collection. These cover latest-per-tag, tag history, and
// building/floor history queries without maintaining redundant indexes.
tagEventSchema.index({ tagId: 1, timestamp: -1 });
tagEventSchema.index({ floorId: 1, tagId: 1, timestamp: -1 });
tagEventSchema.index({ buildingId: 1, floorId: 1, timestamp: -1 });
// Sparse unique index only applies to newly written events. This is safe for
// older documents created before eventKey existed.
tagEventSchema.index({ eventKey: 1 }, { unique: true, sparse: true });

// Retention is based on when our backend received the event, not an upstream
// timestamp that may be delayed or malformed. This makes TTL predictable.
tagEventSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: (Number(process.env.TAG_EVENT_TTL_SECONDS) || 30) * 24 * 60 * 60 },
);

module.exports = mongoose.model("TagEvent", tagEventSchema);
