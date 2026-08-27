const mongoose = require("mongoose");

const tagEventSchema = new mongoose.Schema(
  {
    tagId: { type: String, required: true, index: true },
    buildingId: { type: String, default: null, index: true },
    floorId: { type: String, default: null, index: true },
    groupId: { type: mongoose.Schema.Types.Mixed, default: null },
    groupName: { type: String, default: null },
    tagName: { type: String, default: null },
    event: { type: String, default: "position_update" },
    status: { type: String, default: "ALIVE" },
    movementStatus: { type: String, default: "UNKNOWN" },
    x: { type: Number, default: null },
    y: { type: Number, default: null },
    z: { type: Number, default: null },
    rawData: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

tagEventSchema.index({ buildingId: 1, floorId: 1, timestamp: -1 });
tagEventSchema.index({ tagId: 1, timestamp: -1 });

module.exports = mongoose.model("TagEvent", tagEventSchema);
