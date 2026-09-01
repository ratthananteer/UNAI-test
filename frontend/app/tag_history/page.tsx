// STANDALONE TAG HISTORY PAGE:
// Loads saved TagEvent records from MongoDB through /api/tag-events.
// Users can filter by tag/building/floor, view the matching database floor map,
// and replay a selected tag's historical positions with the timeline controls.

"use client";

import { useEffect, useMemo, useState } from "react";

type Item = Record<string, unknown>;

type HistoryEvent = {
  _id: string;
  tagId: string;
  tagName?: string | null;
  buildingId?: string | number | null;
  floorId?: string | number | null;
  groupName?: string | null;
  event: string;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  timestamp: string;
  rawData?: Record<string, unknown>;
  firstname?: string;
  lastname?: string;
};

type FloorMap = {
  id: string | number;
  name: string;
  map_path: string | null;
  map_width: number | null;
  map_height: number | null;
  pixel_meter: number | null;
  origin_x: number | null;
  origin_y: number | null;
};

function valueId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function arrayFrom(value: unknown): Item[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Item =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }

  if (value && typeof value === "object") {
    const object = value as Item;
    for (const key of ["data", "items", "results"] as const) {
      const candidate = object[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (item): item is Item =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        );
      }
    }
  }

  return [];
}

function mapImageUrl(path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;

  // map_path comes from the RTLS database and points to the RTLS server's
  // uploads directory. Do not resolve it against the Next.js host
  // (localhost:3000 / the frontend Render service), otherwise the image is
  // requested from a directory that does not exist in the frontend container.
  const rtlsBase = "https://rtls.lailab.online";
  return `${rtlsBase}/${path.replace(/^\/+/, "")}`;
}

function getFloorMap(item: Item): FloorMap | null {
  const id = valueId(item.id ?? item.floor_id ?? item.floorId);
  if (id === undefined) return null;

  return {
    id,
    name: stringValue(
      item.name ?? item.floor_name ?? item.title,
      `Floor ${String(id)}`,
    ),
    map_path: stringValue(item.map_path ?? item.mapPath, "") || null,
    map_width: numberValue(item.map_width ?? item.mapWidth),
    map_height: numberValue(item.map_height ?? item.mapHeight),
    pixel_meter: numberValue(item.pixel_meter ?? item.pixelMeter ?? item.pixel_per_meter),
    origin_x: numberValue(item.origin_x ?? item.originX),
    origin_y: numberValue(item.origin_y ?? item.originY),
  };
}

type TagMetadata = Item & {
  tagId?: string | number;
  id?: string | number;
  firstname?: string;
  lastname?: string;
  first_name?: string;
  last_name?: string;
  firstName?: string;
  lastName?: string;
  ui_display?: string;
  label?: string;
  name?: string;
  tag_name?: string;
  tagName?: string;
};

function collectTagMetadata(value: unknown, output: Map<string, TagMetadata> = new Map()): Map<string, TagMetadata> {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectTagMetadata(item, output));
    return output;
  }
  const item = value as TagMetadata;
  const id = item.tagId ?? item.tag_id ?? item.tagID ?? item.id;
  if (id !== undefined && id !== null) output.set(String(id), item);
  Object.values(item).forEach((child) => {
    if (child && typeof child === "object") collectTagMetadata(child, output);
  });
  return output;
}

function tagUserName(tag: TagMetadata | undefined): string {
  if (!tag) return "";
  const first = String(tag.firstname ?? tag.first_name ?? tag.firstName ?? "").trim();
  const last = String(tag.lastname ?? tag.last_name ?? tag.lastName ?? "").trim();
  return [first, last].filter(Boolean).join(" ").trim() || String(tag.ui_display ?? tag.label ?? tag.name ?? tag.tag_name ?? tag.tagName ?? "").trim();
}

function userNameOf(event: HistoryEvent, tagMetadata: Map<string, TagMetadata>): string {
  const liveName = tagUserName(tagMetadata.get(String(event.tagId)));
  if (liveName) return liveName;
  const raw = event.rawData ?? {};
  const first = String(event.firstname ?? raw.firstname ?? raw.first_name ?? raw.firstName ?? "").trim();
  const last = String(event.lastname ?? raw.lastname ?? raw.last_name ?? raw.lastName ?? "").trim();
  return [first, last].filter(Boolean).join(" ").trim() || String(event.tagName ?? event.tagId);
}

function floorIdOf(event: HistoryEvent): string | number | undefined {
  return valueId(event.floorId);
}

function polygonPoints(value: unknown, floor: FloorMap): string | null {
  let parsed: unknown = value;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;

  const polygon = (parsed as Record<string, unknown>).polygon;
  if (!Array.isArray(polygon)) return null;

  const width = floor.map_width;
  const height = floor.map_height;
  const originX = floor.origin_x;
  const originY = floor.origin_y;
  const pixelMeter = floor.pixel_meter;

  const points = polygon
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => {
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      // Zone polygon coordinates use the RTLS floor coordinate system, not
      // image pixels. Keep this conversion identical to LiveMap.toPixel().
      if (
        width != null &&
        height != null &&
        originX != null &&
        originY != null &&
        pixelMeter != null &&
        pixelMeter > 0
      ) {
        const pixelX = originX + x * pixelMeter;
        const pixelY = originY - y * pixelMeter;
        return `${pixelX},${pixelY}`;
      }

      return `${x},${y}`;
    })
    .filter((point): point is string => point !== null);

  return points.length >= 3 ? points.join(" ") : null;
}

function zoneFloorId(zone: Item): string | number | undefined {
  const direct = valueId(
    zone.floor_id ?? zone.floorId ?? zone.floorID,
  );
  if (direct !== undefined) return direct;

  if (zone.floor && typeof zone.floor === "object" && !Array.isArray(zone.floor)) {
    return valueId((zone.floor as Item).id ?? (zone.floor as Item).floor_id);
  }

  return undefined;
}

export default function TagHistoryPage() {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [tagMetadata, setTagMetadata] = useState<Map<string, TagMetadata>>(new Map());
  const [floors, setFloors] = useState<FloorMap[]>([]);
  const [zones, setZones] = useState<Item[]>([]);
  const [tagId, setTagId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [loading, setLoading] = useState(true);
  const [mapLoading, setMapLoading] = useState(true);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);

  async function loadTagMetadata() {
    try {
      // Use the exact same /api/tag source that BuildingPage passes to LiveMap.
      const response = await fetch("/api/tag", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      const metadata = collectTagMetadata(data);
      console.log(`[TagHistory] Loaded ${metadata.size} tag records from /api/tag`);
      setTagMetadata(metadata);
    } catch (error) {
      console.error("[TagHistory] Failed to load tag metadata:", error);
      setTagMetadata(new Map());
    }
  }

  async function loadMapData() {
    setMapLoading(true);

    try {
      const [floorResponse, zoneResponse] = await Promise.all([
        fetch("/api/floors", { cache: "no-store" }),
        fetch("/api/zone", { cache: "no-store" }),
      ]);

      if (!floorResponse.ok) {
        throw new Error(`Failed to load floors: HTTP ${floorResponse.status}`);
      }

      const floorData = await floorResponse.json();
      const zoneData = zoneResponse.ok ? await zoneResponse.json() : [];

      const loadedFloors = arrayFrom(floorData)
        .map(getFloorMap)
        .filter((item): item is FloorMap => item !== null);

      console.log("[TagHistory] Floor data from database:", loadedFloors);
      console.log("[TagHistory] Zone data from database:", arrayFrom(zoneData));

      setFloors(loadedFloors);
      setZones(arrayFrom(zoneData));
    } catch (err) {
      console.error("[TagHistory] Map data failed:", err);
      setFloors([]);
      setZones([]);
    } finally {
      setMapLoading(false);
    }
  }

  async function loadHistory() {
    setLoading(true);
    setError("");
    setPlaying(false);

    try {
      const params = new URLSearchParams();
      if (tagId.trim()) params.set("tagId", tagId.trim());
      if (buildingId.trim()) params.set("buildingId", buildingId.trim());
      if (floorId.trim()) params.set("floorId", floorId.trim());
      params.set("limit", "500");

      const response = await fetch(`/api/tag-events?${params.toString()}`, {
        cache: "no-store",
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const loaded = Array.isArray(data) ? (data as HistoryEvent[]) : [];

      loaded.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      console.log("[TagHistory] History events:", loaded);
      setEvents(loaded);
      setHistoryIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void Promise.all([loadHistory(), loadMapData(), loadTagMetadata()]);
  }, []);

  const availableTags = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of events) {
      const id = String(event.tagId ?? "").trim();
      if (id) map.set(id, `${userNameOf(event, tagMetadata)} (${id})`);
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [events, tagMetadata]);

  const selectedTagEvents = useMemo(() => {
    if (!tagId.trim()) return [];
    return events.filter((event) => String(event.tagId) === tagId.trim());
  }, [events, tagId]);

  useEffect(() => {
    if (!playing || selectedTagEvents.length <= 1) return;

    const timer = window.setInterval(() => {
      setHistoryIndex((current) => {
        if (current >= selectedTagEvents.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 250);

    return () => window.clearInterval(timer);
  }, [playing, selectedTagEvents.length]);

  const currentEvent = selectedTagEvents[historyIndex];

  const currentFloor = useMemo(() => {
    const currentId = currentEvent ? floorIdOf(currentEvent) : undefined;
    if (currentId === undefined) return floors[0];
    return floors.find((floor) => String(floor.id) === String(currentId));
  }, [currentEvent, floors]);

  const currentFloorZones = useMemo(() => {
    if (!currentFloor) return [];

    return zones.filter((zone) => {
      const zoneFloor = zoneFloorId(zone);
      return zoneFloor === undefined || String(zoneFloor) === String(currentFloor.id);
    });
  }, [currentFloor, zones]);

  const currentMapUrl = mapImageUrl(currentFloor?.map_path ?? null);

  const tagPosition = useMemo(() => {
    if (!currentEvent || currentEvent.x == null || currentEvent.y == null || !currentFloor) {
      return null;
    }

    const x = Number(currentEvent.x);
    const y = Number(currentEvent.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    // RTLS history coordinates are converted using the same floor origin/map
    // configuration stored in MongoDB. If the database has no origin/pixel
    // calibration, fall back to the raw coordinate values as percentages.
    const width = currentFloor.map_width;
    const height = currentFloor.map_height;
    const originX = currentFloor.origin_x;
    const originY = currentFloor.origin_y;
    const pixelMeter = currentFloor.pixel_meter;

    if (
      width != null &&
      height != null &&
      originX != null &&
      originY != null &&
      pixelMeter != null &&
      pixelMeter > 0
    ) {
      const pixelX = originX + x * pixelMeter;
      const pixelY = originY - y * pixelMeter;

      return {
        left: Math.max(0, Math.min(100, (pixelX / width) * 100)),
        top: Math.max(0, Math.min(100, (pixelY / height) * 100)),
      };
    }

    return {
      left: Math.max(0, Math.min(100, x)),
      top: Math.max(0, Math.min(100, y)),
    };
  }, [currentEvent, currentFloor]);

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Tag History</h1>
            <p className="text-sm text-slate-500">
              Replay historical tag movement on the database floor map.
            </p>
          </div>
          <button
            onClick={() => void Promise.all([loadHistory(), loadMapData(), loadTagMetadata()])}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Refresh
          </button>
        </div>

        <div className="mb-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-4">
          <select
            value={tagId}
            onChange={(e) => {
              setTagId(e.target.value);
              setHistoryIndex(0);
              setPlaying(false);
            }}
            className="rounded-lg border px-3 py-2 text-sm"
            aria-label="Select one tag"
          >
            <option value="">Select one Tag ID</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.label}</option>
            ))}
          </select>
          <input
            value={buildingId}
            onChange={(e) => setBuildingId(e.target.value)}
            placeholder="Building ID"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <input
            value={floorId}
            onChange={(e) => setFloorId(e.target.value)}
            placeholder="Floor ID"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <button
            onClick={() => void loadHistory()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Search
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="mb-6 overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="border-b p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">History Map Replay</h2>
                <p className="text-sm text-slate-500">
                  The map, floor configuration, and zones come from the database.
                </p>
              </div>
              {currentEvent && (
                <div className="text-right text-sm">
                  <div className="font-medium">
                    Tag ID: {currentEvent.tagId}
                  </div>
                  <div className="text-slate-500">
                    {new Date(currentEvent.timestamp).toLocaleString()}
                  </div>
                  {currentFloor && (
                    <div className="text-xs text-slate-400">
                      {currentFloor.name}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="relative min-h-[420px] overflow-hidden bg-slate-100">
            {mapLoading ? (
              <div className="flex h-[420px] items-center justify-center text-sm text-slate-400">
                Loading floor map from database...
              </div>
            ) : currentFloor && currentMapUrl ? (
              <div className="relative flex min-h-[420px] w-full items-center justify-center overflow-hidden bg-slate-200">
                <div
                  className="relative w-full max-w-[1000px]"
                  style={{
                    aspectRatio: `${currentFloor.map_width ?? 1600}/${currentFloor.map_height ?? 900}`,
                  }}
                >
                  <img
                    src={currentMapUrl}
                    alt={`${currentFloor.name} floor map`}
                    className="absolute inset-0 block h-full w-full object-fill"
                    onError={(event) => {
                      console.error("[TagHistory] Failed to load map image:", currentMapUrl);
                      event.currentTarget.style.display = "none";
                    }}
                  />

                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox={`0 0 ${currentFloor.map_width ?? 1600} ${currentFloor.map_height ?? 900}`}
                    preserveAspectRatio="none"
                  >
                    {currentFloorZones.map((zone, index) => {
                      const points = polygonPoints(zone.polygon_data, currentFloor);
                      if (!points) return null;

                      const color =
                        typeof zone.zone_color === "string"
                          ? zone.zone_color
                          : "#5dc6ba";

                      return (
                        <polygon
                          key={String(zone.id ?? index)}
                          points={points}
                          fill={color}
                          fillOpacity={0.2}
                          stroke={color}
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  </svg>

                  {tagPosition && (
                    <div
                      className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-[left,top] duration-150"
                      style={{
                        left: `${tagPosition.left}%`,
                        top: `${tagPosition.top}%`,
                      }}
                      title={`Tag ID: ${currentEvent?.tagId} · X: ${currentEvent?.x}, Y: ${currentEvent?.y}`}
                    >
                      <div className="flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-white bg-sky-600 px-2 text-[9px] font-bold text-white shadow-lg ring-2 ring-sky-300">T</div>
                      <span className="mt-1 max-w-28 truncate rounded bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 shadow">{userNameOf(currentEvent, tagMetadata)}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-[420px] items-center justify-center p-6 text-center text-sm text-slate-400">
                {currentFloor
                  ? "This floor has no map_path in the database."
                  : "No floor matching the current history event was found in the database."}
              </div>
            )}

            {currentEvent && (
              <div className="absolute bottom-4 left-4 rounded-lg bg-white/90 px-3 py-2 text-xs shadow">
                <div className="font-medium">User: {userNameOf(currentEvent, tagMetadata)}</div>
                <div className="text-slate-500">Tag ID: {currentEvent.tagId}</div>
                <div>
                  X: {currentEvent.x ?? "-"} · Y: {currentEvent.y ?? "-"}
                  {currentEvent.z != null ? ` · Z: ${currentEvent.z}` : ""}
                </div>
                <div>Event: {currentEvent.event}</div>
                <div>Floor: {currentFloor?.name ?? currentEvent.floorId ?? "-"}</div>
              </div>
            )}
          </div>

          <div className="border-t p-4">
            <div className="mb-3 flex items-center gap-3">
              <button
                onClick={() => {
                  if (!selectedTagEvents.length) return;
                  if (historyIndex >= selectedTagEvents.length - 1) setHistoryIndex(0);
                  setPlaying((value) => !value);
                }}
                disabled={selectedTagEvents.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {playing
                  ? "Pause"
                  : historyIndex >= events.length - 1
                    ? "Replay"
                    : "Play"}
              </button>
              <button
                onClick={() => {
                  setPlaying(false);
                  setHistoryIndex(0);
                }}
                disabled={selectedTagEvents.length === 0}
                className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                Start
              </button>
              <div className="ml-auto text-xs text-slate-500">
                {selectedTagEvents.length ? `${historyIndex + 1} / ${selectedTagEvents.length}` : "0 / 0"}
              </div>
            </div>

            <input
              type="range"
              min={0}
              max={Math.max(0, selectedTagEvents.length - 1)}
              value={historyIndex}
              onChange={(e) => {
                setPlaying(false);
                setHistoryIndex(Number(e.target.value));
              }}
              disabled={selectedTagEvents.length <= 1}
              className="w-full cursor-pointer disabled:cursor-not-allowed"
              aria-label="Tag history timeline"
            />

            <div className="mt-2 flex justify-between text-xs text-slate-400">
              <span>
                {selectedTagEvents[0]
                  ? new Date(selectedTagEvents[0].timestamp).toLocaleString()
                  : "-"}
              </span>
              <span>
                {currentEvent
                  ? new Date(currentEvent.timestamp).toLocaleString()
                  : "-"}
              </span>
              <span>
                {selectedTagEvents.length
                  ? new Date(selectedTagEvents[selectedTagEvents.length - 1].timestamp).toLocaleString()
                  : "-"}
              </span>
            </div>
          </div>
        </section>

        <div className="mb-4 text-sm text-slate-500">
          {loading ? "Loading..." : tagId ? `${selectedTagEvents.length} history event(s) for Tag ${tagId}` : "Select one Tag ID to view its history"}
          {floors.length > 0 && ` · ${floors.length} database floor(s)`}
          {zones.length > 0 && ` · ${zones.length} database zone(s)`}
        </div>

        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b bg-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Tag</th>
                <th className="px-4 py-3">Building</th>
                <th className="px-4 py-3">Floor</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">X</th>
                <th className="px-4 py-3">Y</th>
                <th className="px-4 py-3">Z</th>
              </tr>
            </thead>
            <tbody>
              {selectedTagEvents.map((event, index) => (
                <tr
                  key={event._id || `${event.tagId}-${event.timestamp}-${index}`}
                  onClick={() => {
                    setPlaying(false);
                    setHistoryIndex(index);
                  }}
                  className={`cursor-pointer border-b last:border-0 hover:bg-slate-50 ${
                    index === historyIndex ? "bg-blue-50" : ""
                  }`}
                >
                  <td className="whitespace-nowrap px-4 py-3">
                    {new Date(event.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <div className="text-slate-800">{userNameOf(event, tagMetadata)}</div>
                  </td>
                  <td className="px-4 py-3">{event.buildingId ?? "-"}</td>
                  <td className="px-4 py-3">{event.floorId ?? "-"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium">
                      {event.event}
                    </span>
                  </td>
                  <td className="px-4 py-3">{event.x ?? "-"}</td>
                  <td className="px-4 py-3">{event.y ?? "-"}</td>
                  <td className="px-4 py-3">{event.z ?? "-"}</td>
                </tr>
              ))}
              {!loading && events.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    No tag history found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
