"use client";

import { useMemo, useState } from "react";
import LiveMap from "./LiveMap";

type Item = Record<string, unknown>;

function idOf(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function num(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function floorId(item: Item): string | number | undefined {
  return idOf(item.id ?? item.floor_id ?? item.floorId);
}

function belongsToFloor(item: Item, selectedId: string | number): boolean {
  const value = idOf(item.floor_id ?? item.floorId ?? item.floor ?? item.floorID);
  return value === undefined || String(value) === String(selectedId);
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
    () => floors.filter((floor) => floorId(floor) !== undefined),
    [floors],
  );

  const [selectedFloorId, setSelectedFloorId] = useState<string | number | undefined>(
    floorId(usableFloors[0]),
  );
  const [tagIdFilter, setTagIdFilter] = useState("");

  const selectedFloor = useMemo(() => {
    return usableFloors.find((floor) => String(floorId(floor)) === String(selectedFloorId));
  }, [usableFloors, selectedFloorId]);

  if (!selectedFloor || selectedFloorId === undefined) {
    return (
      <section className="mt-6 rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Live Map</h2>
        <p className="mt-3 text-sm text-gray-500">
          No floor with a valid floor ID is available for this building.
        </p>
      </section>
    );
  }

  const floor: Record<string, unknown> = selectedFloor;
  const floorValue = (key: string) => floor[key];

  const liveFloor = {
    id: selectedFloorId,
    name: str(floorValue("name") ?? floorValue("floor_name") ?? floorValue("title"), `Floor ${String(selectedFloorId)}`),
    map_path: (floorValue("map_path") ?? floorValue("mapPath") ?? null) as string | null,
    map_width: num(floorValue("map_width") ?? floorValue("mapWidth")),
    map_height: num(floorValue("map_height") ?? floorValue("mapHeight")),
    pixel_meter: num(floorValue("pixel_meter") ?? floorValue("pixelMeter")),
    origin_x: num(floorValue("origin_x") ?? floorValue("originX")),
    origin_y: num(floorValue("origin_y") ?? floorValue("originY")),
  };

  const liveAnchors = anchors.filter((item) => belongsToFloor(item, selectedFloorId)).map((item) => ({
    id: idOf(item.id ?? item.anchor_id ?? item.anchorId),
    x: idOf(item.x ?? item.pos_x ?? item.position_x) as number | string | null,
    y: idOf(item.y ?? item.pos_y ?? item.position_y) as number | string | null,
    label: str(item.label ?? item.name ?? item.id, "Anchor"),
    status: typeof item.status === "number" ? item.status : undefined,
  }));

  const liveTags = tags.filter((item) => belongsToFloor(item, selectedFloorId));
  const liveZones = zones.filter((item) => belongsToFloor(item, selectedFloorId)).map((item) => ({
    id: idOf(item.id ?? item.zone_id ?? item.zoneId),
    name: str(item.name ?? item.zone_name ?? item.title, "Zone"),
    polygon_data: typeof item.polygon_data === "string" ? item.polygon_data : null,
    zone_color: typeof item.zone_color === "string" ? item.zone_color : null,
  }));

  return (
    <section className="mt-6 overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white p-4">
        <div>
         
          <p className="text-sm text-gray-500">
            Real-time tag and anchor locations
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="building-tag-filter" className="text-sm font-medium text-slate-600">
            Tag ID
          </label>
          <input
            id="building-tag-filter"
            type="text"
            inputMode="numeric"
            value={tagIdFilter}
            onChange={(event) => setTagIdFilter(event.target.value)}
            placeholder="All tags"
            className="w-36 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Filter map by tag ID"
          />
          {tagIdFilter.trim() && (
            <button
              type="button"
              onClick={() => setTagIdFilter("")}
              className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Clear
            </button>
          )}

          <select
            value={String(selectedFloorId)}
            onChange={(event) => setSelectedFloorId(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-blue-500"
            aria-label="Select floor"
          >
            {usableFloors.map((item) => {
              const value = floorId(item)!;
              return (
                <option key={String(value)} value={String(value)}>
                  {str(item.name ?? item.floor_name ?? item.title, `Floor ${String(value)}`)}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      <LiveMap
        placeId={placeId}
        buildingId={buildingId}
        floor={liveFloor}
        anchors={liveAnchors}
        tags={liveTags as Parameters<typeof LiveMap>[0]["tags"]}
        tagIdFilter={tagIdFilter}
        zones={liveZones}
      />
    </section>
  );
}
