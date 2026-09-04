// MONGODB OPTIMIZATION:
// Creates the indexes used by the RTLS read/write paths and builds the
// lightweight TagLatest read model from existing TagEvent history.

const TagEvent = require("../models/TagEvent");
const TagLatest = require("../models/TagLatest");
const StaticData = require("../models/StaticData");

async function backfillTagLatest() {
  // This migration is only needed when TagLatest is empty (first deployment or
  // an intentional rebuild). Scanning the full history on every Render restart
  // would turn startup cost into O(TagEvent history size).
  const existingCount = await TagLatest.estimatedDocumentCount();
  if (existingCount > 0) {
    console.log(`[MongoDB] TagLatest backfill skipped: ${existingCount} snapshot(s) already exist`);
    return 0;
  }

  const latest = await TagEvent.aggregate([
    { $match: { isAsset: { $ne: true } } },
    { $sort: { tagId: 1, timestamp: -1 } },
    {
      $group: {
        _id: "$tagId",
        latest: { $first: "$$ROOT" },
      },
    },
  ]);

  if (!latest.length) return 0;

  const operations = latest.map(({ latest: event }) => ({
    updateOne: {
      filter: { tagId: event.tagId },
      update: {
        $set: {
          tagId: event.tagId,
          buildingId: event.buildingId ?? null,
          floorId: event.floorId ?? null,
          groupId: event.groupId ?? null,
          groupName: event.groupName ?? null,
          tagName: event.tagName ?? null,
          status: event.status || "ALIVE",
          movementStatus: event.movementStatus || "UNKNOWN",
          isAsset: false,
          x: event.x ?? null,
          y: event.y ?? null,
          z: event.z ?? null,
          timestamp: event.timestamp,
          receivedAt: event.receivedAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  await TagLatest.bulkWrite(operations, { ordered: false });
  return latest.length;
}

async function optimizeDatabase() {
  const startedAt = Date.now();

  await Promise.all([
    TagEvent.createIndexes(),
    TagLatest.createIndexes(),
    StaticData.createIndexes(),
  ]);

  try {
    const count = await backfillTagLatest();
    console.log(`[MongoDB] TagLatest backfill: ${count} tag(s)`);
  } catch (error) {
    // Index creation and server startup should not fail only because an old
    // history record cannot be promoted into the read model.
    console.error(`[MongoDB] TagLatest backfill skipped: ${error.message}`);
  }

  console.log(`[MongoDB] Index optimization complete in ${Date.now() - startedAt}ms`);
}

module.exports = { optimizeDatabase, backfillTagLatest };
