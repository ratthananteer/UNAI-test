"use client";

import { useEffect, useMemo, useState } from "react";
import LiveMap from "./LiveMap";

type Item = Record<string, unknown>;

function idOf(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function num(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function floorId(item: Item): string | number | undefined {
  return idOf(item.id ?? item.floor_id ?? item.floorId);
}

function belongsToFloor(
  item: Item,
  selectedId: string | number,
): boolean {
  const value = idOf(
    item.floor_id ??
      item.floorId ??
      item.floor ??
      item.floorID,
  );

  return (
    value === undefined ||
    String(value) === String(selectedId)
  );
}

export default function BuildingLiveMap({
  placeId,
  buildingId,
  floors,
  anchors,
  tags,
  zones,
}: {
  placeId: string | number;
  buildingId: string | number;
  floors: Item[];
  anchors: Item[];
  tags: Item[];
  zones: Item[];
}) {
  const usableFloors = useMemo(
    () =>
      floors.filter(
        (floor) => floorId(floor) !== undefined,
      ),
    [floors],
  );

  const firstFloorId = useMemo(
    () => floorId(usableFloors[0]),
    [usableFloors],
  );

  const [selectedFloorId, setSelectedFloorId] = useState<
    string | number | undefined
  >(firstFloorId);

  // Keep selected floor valid when floors change.
  useEffect(() => {
    if (usableFloors.length === 0) {
      setSelectedFloorId(undefined);
      return;
    }

    const currentExists = usableFloors.some(
      (floor) =>
        String(floorId(floor)) ===
        String(selectedFloorId),
    );

    if (!currentExists) {
      setSelectedFloorId(firstFloorId);
    }
  }, [
    usableFloors,
    selectedFloorId,
    firstFloorId,
  ]);

  const selectedFloor = useMemo(() => {
    if (selectedFloorId === undefined) {
      return undefined;
    }

    return usableFloors.find(
      (floor) =>
        String(floorId(floor)) ===
        String(selectedFloorId),
    );
  }, [
    usableFloors,
    selectedFloorId,
  ]);

  if (
    usableFloors.length === 0 ||
    selectedFloorId === undefined ||
    !selectedFloor
  ) {
    return (
      <section className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">
          Live Map
        </h2>

        <p className="mt-3 text-sm text-gray-500">
          No floor with a valid floor ID is available
          for this building.
        </p>
      </section>
    );
  }

  const floor = selectedFloor;

  const liveFloor = {
    id: selectedFloorId,
    name: str(
      floor.name ??
        floor.floor_name ??
        floor.title,
      `Floor ${String(selectedFloorId)}`,
    ),
    map_path:
      typeof floor.map_path === "string"
        ? floor.map_path
        : typeof floor.mapPath === "string"
          ? floor.mapPath
          : null,
    map_width: num(
      floor.map_width ??
        floor.mapWidth,
    ),
    map_height: num(
      floor.map_height ??
        floor.mapHeight,
    ),
    pixel_meter: num(
      floor.pixel_meter ??
        floor.pixelMeter,
    ),
    origin_x: num(
      floor.origin_x ??
        floor.originX,
    ),
    origin_y: num(
      floor.origin_y ??
        floor.originY,
    ),
  };

  const liveAnchors = anchors
    .filter((item) =>
      belongsToFloor(
        item,
        selectedFloorId,
      ),
    )
    .map((item, index) => ({
      id:
        idOf(
          item.id ??
            item.anchor_id ??
            item.anchorId,
        ) ?? `anchor-${index}`,

      x:
        num(
          item.x ??
            item.pos_x ??
            item.position_x,
        ) ?? 0,

      y:
        num(
          item.y ??
            item.pos_y ??
            item.position_y,
        ) ?? 0,

      label: str(
        item.label ??
          item.name ??
          item.id,
        "Anchor",
      ),

      status:
        typeof item.status === "number"
          ? item.status
          : undefined,
    }));

  const liveTags = tags.filter((item) =>
    belongsToFloor(
      item,
      selectedFloorId,
    ),
  );

  const liveZones = zones
    .filter((item) =>
      belongsToFloor(
        item,
        selectedFloorId,
      ),
    )
    .map((item, index) => ({
      id:
        idOf(
          item.id ??
            item.zone_id ??
            item.zoneId,
        ) ?? `zone-${index}`,

      name: str(
        item.name ??
          item.zone_name ??
          item.title,
        "Zone",
      ),

      polygon_data:
        typeof item.polygon_data === "string"
          ? item.polygon_data
          : null,

      zone_color:
        typeof item.zone_color === "string"
          ? item.zone_color
          : null,
    }));

  return (
    <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white p-4">
        <div>
          <h2 className="text-xl font-semibold">
            Live Map
          </h2>

          <p className="text-sm text-gray-500">
            Real-time tag and anchor locations
          </p>
        </div>

        <select
          value={String(selectedFloorId)}
          onChange={(event) =>
            setSelectedFloorId(
              event.target.value,
            )
          }
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-blue-500"
          aria-label="Select floor"
        >
          {usableFloors.map((item) => {
            const value = floorId(item);

            if (value === undefined) {
              return null;
            }

            return (
              <option
                key={String(value)}
                value={String(value)}
              >
                {str(
                  item.name ??
                    item.floor_name ??
                    item.title,
                  `Floor ${String(value)}`,
                )}
              </option>
            );
          })}
        </select>
      </div>

      <LiveMap
        placeId={placeId}
        buildingId={buildingId}
        floor={liveFloor}
        anchors={liveAnchors}
        tags={
          liveTags as Parameters<
            typeof LiveMap
          >[0]["tags"]
        }
        zones={liveZones}
      />
    </section>
  );
}