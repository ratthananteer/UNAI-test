// GEOFENCING SERVICE:
// Converts RTLS coordinates into ENTER / EXIT events using the cached Zone
// polygons. It is called by the existing /api/tag-events write path, so this
// does NOT create or restart the Historical Socket Collector.

const StaticData = require("../models/StaticData");
const ZonePresence = require("../models/ZonePresence");
const ZoneEvent = require("../models/ZoneEvent");

function idOf(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePolygon(value) {
  if (!value) return [];

  let parsed = value;
  try {
    if (typeof value === "string") parsed = JSON.parse(value);
  } catch {
    return [];
  }

  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.polygon)
      ? parsed.polygon
      : Array.isArray(parsed?.points)
        ? parsed.points
        : [];

  return raw
    .map((point) => {
      if (Array.isArray(point) && point.length >= 2) {
        return [numberValue(point[0]), numberValue(point[1])];
      }
      if (point && typeof point === "object") {
        return [numberValue(point.x), numberValue(point.y)];
      }
      return [null, null];
    })
    .filter(([x, y]) => x !== null && y !== null);
}

// Ray-casting point-in-polygon. Boundary points are treated as inside so a
// tag sitting exactly on a zone edge does not rapidly alternate states.
function pointInPolygon(x, y, polygon) {
  if (polygon.length < 3) return false;

  let inside = false;
  const epsilon = 1e-9;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    const minX = Math.min(xi, xj) - epsilon;
    const maxX = Math.max(xi, xj) + epsilon;
    const minY = Math.min(yi, yj) - epsilon;
    const maxY = Math.max(yi, yj) + epsilon;
    if (Math.abs(cross) <= epsilon && x >= minX && x <= maxX && y >= minY && y <= maxY) {
      return true;
    }

    const intersects = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function zoneIdOf(zone) {
  return idOf(zone.id ?? zone.zone_id ?? zone.zoneId);
}

function zoneFloorId(zone) {
  return idOf(zone.floor_id ?? zone.floorId ?? zone.floorID ?? zone.floor);
}

function zoneBuildingId(zone) {
  return idOf(zone.building_id ?? zone.buildingId ?? zone.building);
}

function normalizeZone(row) {
  const zone = row?.data ?? row;
  return {
    ...zone,
    id: zoneIdOf(zone),
    name: zone.name ?? zone.zone_name ?? zone.title ?? null,
    floorId: zoneFloorId(zone),
    buildingId: zoneBuildingId(zone),
    polygon: parsePolygon(zone.polygon_data ?? zone.polygon ?? zone.points),
  };
}

async function getZonesForEvents(events) {
  const floorIds = [...new Set(events.map((event) => idOf(event.floorId)).filter(Boolean))];
  const buildingIds = [...new Set(events.map((event) => idOf(event.buildingId)).filter(Boolean))];

  if (!floorIds.length && !buildingIds.length) return [];

  // Zones are static data, so one indexed-ish read is enough for a batch of
  // socket updates. Filtering the actual polygon is done in memory.
  const rows = await StaticData.find({ type: "zone" })
    .select({ _id: 0, data: 1 })
    .lean();

  return rows
    .map(normalizeZone)
    .filter((zone) => zone.id && zone.polygon.length >= 3)
    .filter((zone) => {
      const floorMatch = zone.floorId && floorIds.includes(zone.floorId);
      const buildingMatch = zone.buildingId && buildingIds.includes(zone.buildingId);
      // Prefer exact floor/building matches. If an API zone has neither field,
      // it is allowed because some UNAI deployments only attach floor context
      // through the polygon configuration itself.
      return floorMatch || buildingMatch || (!zone.floorId && !zone.buildingId);
    });
}

async function processGeofenceEvents(events) {
  if (!Array.isArray(events) || !events.length) return { transitions: [] };

  const candidates = events.filter((event) =>
    event?.tagId && numberValue(event.x) !== null && numberValue(event.y) !== null,
  );
  if (!candidates.length) return { transitions: [] };

  const zones = await getZonesForEvents(candidates);
  if (!zones.length) return { transitions: [] };

  const pairKeys = [];
  for (const event of candidates) {
    for (const zone of zones) {
      const floorMatches = !zone.floorId || idOf(event.floorId) === zone.floorId;
      const buildingMatches = !zone.buildingId || idOf(event.buildingId) === zone.buildingId;
      if (floorMatches && buildingMatches) {
        pairKeys.push(`${event.tagId}::${zone.id}`);
      }
    }
  }

  const existingRows = pairKeys.length
    ? await ZonePresence.find({
        $or: pairKeys.map((key) => {
          const [tagId, zoneId] = key.split("::");
          return { tagId, zoneId };
        }),
      }).lean()
    : [];
  const existingByPair = new Map(existingRows.map((row) => [`${row.tagId}::${row.zoneId}`, row]));

  const transitions = [];
  const presenceOperations = [];

  for (const event of candidates) {
    const tagId = idOf(event.tagId);
    const x = numberValue(event.x);
    const y = numberValue(event.y);
    if (!tagId || x === null || y === null) continue;

    for (const zone of zones) {
      const floorMatches = !zone.floorId || idOf(event.floorId) === zone.floorId;
      const buildingMatches = !zone.buildingId || idOf(event.buildingId) === zone.buildingId;
      if (!floorMatches || !buildingMatches) continue;

      const zoneKey = `${tagId}::${zone.id}`;
      const inside = pointInPolygon(x, y, zone.polygon);
      const previous = existingByPair.get(zoneKey);
      const previousStatus = previous?.status ?? "OUTSIDE";
      const nextStatus = inside ? "INSIDE" : "OUTSIDE";
      const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp || Date.now());

      // First observation establishes state but does not generate an ENTER
      // alert. This prevents a flood of false alerts after the service starts.
      if (!previous) {
        const enteredAt = inside ? timestamp : null;
        presenceOperations.push({
          updateOne: {
            filter: { tagId, zoneId: zone.id },
            update: {
              $set: {
                tagId,
                zoneId: zone.id,
                zoneName: zone.name,
                buildingId: idOf(event.buildingId),
                floorId: idOf(event.floorId),
                status: nextStatus,
                enteredAt,
                lastSeenAt: timestamp,
                lastX: x,
                lastY: y,
              },
            },
            upsert: true,
          },
        });
        existingByPair.set(zoneKey, {
          tagId,
          zoneId: zone.id,
          zoneName: zone.name,
          status: nextStatus,
          enteredAt,
          lastSeenAt: timestamp,
          lastX: x,
          lastY: y,
        });
        continue;
      }

      if (previousStatus === nextStatus) {
        presenceOperations.push({
          updateOne: {
            filter: { tagId, zoneId: zone.id },
            update: { $set: { lastSeenAt: timestamp, lastX: x, lastY: y, zoneName: zone.name } },
          },
        });
        continue;
      }

      const transition = nextStatus === "INSIDE" ? "ENTER" : "EXIT";
      transitions.push({
        tagId,
        zoneId: zone.id,
        zoneName: zone.name,
        buildingId: idOf(event.buildingId),
        floorId: idOf(event.floorId),
        event: transition,
        x,
        y,
        timestamp,
      });

      presenceOperations.push({
        updateOne: {
          filter: { tagId, zoneId: zone.id },
          update: {
            $set: {
              status: nextStatus,
              zoneName: zone.name,
              buildingId: idOf(event.buildingId),
              floorId: idOf(event.floorId),
              lastSeenAt: timestamp,
              lastX: x,
              lastY: y,
              ...(nextStatus === "INSIDE" ? { enteredAt: timestamp } : { enteredAt: null }),
            },
          },
          upsert: true,
        },
      });

      existingByPair.set(zoneKey, {
        ...previous,
        status: nextStatus,
        lastSeenAt: timestamp,
        lastX: x,
        lastY: y,
      });
    }
  }

  if (presenceOperations.length) {
    await ZonePresence.bulkWrite(presenceOperations, { ordered: false });
  }
  if (transitions.length) {
    await ZoneEvent.insertMany(transitions, { ordered: false });
    console.log(`[Geofence] ${transitions.length} transition(s): ${transitions.map((item) => `${item.event} tag=${item.tagId} zone=${item.zoneName || item.zoneId}`).join(", ")}`);
  }

  return { transitions };
}

module.exports = {
  parsePolygon,
  pointInPolygon,
  processGeofenceEvents,
};
