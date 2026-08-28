"use client";

import { useEffect, useMemo, useState } from "react";
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
  selectedFloorId: controlledFloorId,
  onFloorChange,
}: {
  placeId: string | number;
  buildingId: string | number;
  floors: Item[];
  anchors: Item[];
  tags: Item[];
  zones: Item[];
  selectedFloorId?: string | number;
  onFloorChange?: (floorId: string | number) => void;
}) {
  const usableFloors = useMemo(
    () => floors.filter((floor) => floorId(floor) !== undefined),
    [floors],
  );

  const [internalFloorId, setInternalFloorId] = useState<string | number | undefined>(
    floorId(usableFloors[0]),
  );
  const selectedFloorId = controlledFloorId ?? internalFloorId;
  const setSelectedFloorId = (value: string | number) => {
    setInternalFloorId(value);
    onFloorChange?.(value);
  };
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
          <h2 className="text-xl font-semibold">Live Map</h2>
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

export function BuildingMapModes({
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
  const validFloors = useMemo(() => floors.filter((item) => floorId(item) !== undefined), [floors]);
  const [mode, setMode] = useState<"live" | "history">("live");
  const [selectedFloorId, setSelectedFloorId] = useState<string | number | undefined>(floorId(validFloors[0]));

  useEffect(() => {
    const exists = validFloors.some((item) => String(floorId(item)) === String(selectedFloorId));
    if (!exists) {
      const first = floorId(validFloors[0]);
      if (first !== undefined) setSelectedFloorId(first);
    }
  }, [validFloors, selectedFloorId]);

  return (
    <section className="mt-6 overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="text-xl font-semibold">Building Map</h2>
          <p className="text-sm text-slate-500">Live tracking and tag history share the same floor. History shows all tags by default.</p>
        </div>
        <div className="flex rounded-lg border bg-slate-100 p-1">
          <button type="button" onClick={() => setMode("live")} className={`rounded-md px-4 py-2 text-sm font-medium ${mode === "live" ? "bg-white text-blue-700 shadow-sm" : "text-slate-600"}`}>Live Map</button>
          <button type="button" onClick={() => setMode("history")} className={`rounded-md px-4 py-2 text-sm font-medium ${mode === "history" ? "bg-white text-blue-700 shadow-sm" : "text-slate-600"}`}>Tag History</button>
        </div>
      </div>
      {mode === "live" ? (
        <BuildingLiveMap placeId={placeId} buildingId={buildingId} floors={floors} anchors={anchors} tags={tags} zones={zones} selectedFloorId={selectedFloorId} onFloorChange={setSelectedFloorId} />
      ) : (
        <BuildingTagHistory buildingId={buildingId} floors={floors} zones={zones} selectedFloorId={selectedFloorId} onFloorChange={setSelectedFloorId} />
      )}
    </section>
  );
}

function BuildingTagHistory({
  buildingId,
  floors,
  zones,
  selectedFloorId,
  onFloorChange,
}: {
  buildingId: string | number;
  floors: Item[];
  zones: Item[];
  selectedFloorId?: string | number;
  onFloorChange: (id: string | number) => void;
}) {
  type HistoryEvent = { _id?: string; tagId?: string | number; tagName?: string | null; floorId?: string | number | null; x?: number | null; y?: number | null; timestamp: string; event?: string };
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [tagId, setTagId] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [allHistoryIndex, setAllHistoryIndex] = useState(0);
  const ALL_HISTORY_VISIBLE = 5;

  const selectedFloor = useMemo(() => floors.find((item) => String(floorId(item)) === String(selectedFloorId)), [floors, selectedFloorId]);

  // All building history, sorted from oldest to newest.
  const history = useMemo(
    () => [...events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
    [events],
  );

  // Playback is only for a selected tag. Leaving the selector on "All Tags"
  // keeps the map in the default all-history view.
  const selectedHistory = useMemo(
    () => tagId
      ? history.filter((event) => String(event.tagId ?? "") === tagId)
      : [],
    [history, tagId],
  );

  // When a tag is selected, only show positions up to the current
  // timeline point. Future positions are hidden.
  const allHistoryMaxIndex = Math.max(0, history.length - ALL_HISTORY_VISIBLE);

  const visibleHistory = useMemo(() => {
    if (tagId) return selectedHistory.slice(0, index + 1);

    const end = Math.min(allHistoryIndex + ALL_HISTORY_VISIBLE, history.length);
    const upToCutoff = history.slice(0, end);
    const grouped = new Map<string, HistoryEvent[]>();

    for (const event of upToCutoff) {
      const id = String(event.tagId ?? "unknown");
      const list = grouped.get(id) ?? [];
      list.push(event);
      grouped.set(id, list);
    }

    return Array.from(grouped.values()).flatMap((tagEvents) =>
      tagEvents.slice(-ALL_HISTORY_VISIBLE),
    );
  }, [history, selectedHistory, tagId, index, allHistoryIndex]);

  const mapHistory = useMemo(
    () => visibleHistory.filter((event) => {
      if (event.x == null || event.y == null) return false;
      if (event.floorId == null || selectedFloorId == null) return false;
      return String(event.floorId) === String(selectedFloorId);
    }),
    [visibleHistory, selectedFloorId],
  );

  const historyByTag = useMemo(() => {
    const grouped = new Map<string, HistoryEvent[]>();
    for (const event of mapHistory) {
      const id = String(event.tagId ?? "unknown");
      const list = grouped.get(id) ?? [];
      list.push(event);
      grouped.set(id, list);
    }
    return Array.from(grouped.entries());
  }, [mapHistory]);

  const current = selectedHistory[index];

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/tag-events?buildingId=${encodeURIComponent(String(buildingId))}&limit=500`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setEvents(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("[BuildingTagHistory] Failed to load history:", error);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [buildingId]);

  useEffect(() => {
    setPlaying(false);
    // Start at the latest known position: all past positions are visible,
    // while positions after the selected timeline point are never shown.
    setIndex(tagId ? Math.max(0, selectedHistory.length - 1) : 0);
    setAllHistoryIndex(allHistoryMaxIndex);
  }, [tagId, selectedHistory.length, allHistoryMaxIndex]);

  useEffect(() => {
    if (!playing || selectedHistory.length <= 1) return;
    const timer = window.setInterval(() => setIndex((value) => {
      if (value >= selectedHistory.length - 1) { setPlaying(false); return value; }
      return value + 1;
    }), 250);
    return () => window.clearInterval(timer);
  }, [playing, selectedHistory.length]);

  useEffect(() => {
    const eventFloor = current?.floorId;
    if (eventFloor !== undefined && eventFloor !== null && String(eventFloor) !== String(selectedFloorId)) onFloorChange(eventFloor);
  }, [current?.floorId, selectedFloorId, onFloorChange]);

  function num(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  function mapUrl(value: unknown) { if (!value) return null; const p = String(value); return /^https?:\/\//i.test(p) ? p : `https://rtls.lailab.online/${p.replace(/^\/+/, "")}`; }
  function polygon(value: unknown) { try { const p = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(p?.polygon) ? p.polygon : []; } catch { return []; } }

  if (!selectedFloor) return <div className="p-6 text-sm text-slate-500">No floor available for this building.</div>;

  const width = num(selectedFloor.map_width ?? selectedFloor.mapWidth) ?? 1600;
  const height = num(selectedFloor.map_height ?? selectedFloor.mapHeight) ?? 900;
  const scale = num(selectedFloor.pixel_meter ?? selectedFloor.pixelMeter) ?? 1;
  const ox = num(selectedFloor.origin_x ?? selectedFloor.originX) ?? 0;
  const oy = num(selectedFloor.origin_y ?? selectedFloor.originY) ?? 0;
  const map = mapUrl(selectedFloor.map_path ?? selectedFloor.mapPath);
  const x = num(current?.x);
  const y = num(current?.y);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        <select value={tagId} onChange={(e) => { setTagId(e.target.value); setIndex(0); setPlaying(false); }} className="rounded-lg border px-3 py-2 text-sm" aria-label="Select one tag">
          <option value="">All Tags — show all history</option>
          {Array.from(new Map(events.filter((e) => e.tagId !== undefined).map((e) => [String(e.tagId), e.tagName ? `${e.tagName} (${e.tagId})` : String(e.tagId)])).entries()).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select value={String(selectedFloorId ?? "")} onChange={(e) => onFloorChange(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" aria-label="Select floor">
          {validFloorOptions(floors).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button type="button" disabled={!selectedHistory.length} onClick={() => { if (index >= selectedHistory.length - 1) setIndex(0); setPlaying((v) => !v); }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{playing ? "Pause" : "Play"}</button>
        <span className="ml-auto text-xs text-slate-500">
          {tagId
            ? (selectedHistory.length ? `${index + 1} / ${selectedHistory.length}` : "No history for this tag")
            : `${mapHistory.length} history points · All tags · max 5/tag`}
        </span>
      </div>
      <div className="overflow-auto bg-slate-100 p-4">
        <div className="relative mx-auto max-w-[1000px] overflow-hidden rounded-xl border bg-white" style={{ aspectRatio: `${width}/${height}` }}>
          {map && <img src={map} alt={String(selectedFloor.name ?? "Floor map")} className="absolute inset-0 h-full w-full object-fill" />}
          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
            {zones.filter((zone) => { const zid = valueId(zone.floor_id ?? zone.floorId ?? zone.floorID); return zid === undefined || String(zid) === String(selectedFloorId); }).map((zone, zi) => {
              const points = polygon(zone.polygon_data).map((point: unknown) => { if (!Array.isArray(point) || point.length < 2) return null; const px = num(point[0]); const py = num(point[1]); if (px === null || py === null) return null; return `${ox + px * scale},${oy - py * scale}`; }).filter((v: string | null): v is string => v !== null).join(" ");
              if (!points) return null; const color = typeof zone.zone_color === "string" ? zone.zone_color : "#5dc6ba";
              return <polygon key={String(zone.id ?? zi)} points={points} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
            })}
          </svg>
          {historyByTag.map(([groupTagId, tagEvents], groupIndex) => {
            const points = tagEvents
              .map((event) => {
                const px = num(event.x);
                const py = num(event.y);
                if (px === null || py === null) return null;
                return `${ox + px * scale},${oy - py * scale}`;
              })
              .filter((point): point is string => point !== null)
              .join(" ");

            if (!points) return null;

            const isSelected = tagId !== "" && groupTagId === tagId;
            const stroke = isSelected
              ? "#ef4444"
              : `hsl(${(groupIndex * 137.5) % 360} 70% 45%)`;

            return (
              <polyline
                key={`history-line-${groupTagId}`}
                points={points}
                fill="none"
                stroke={stroke}
                strokeWidth={isSelected ? 4 : 2}
                strokeOpacity={isSelected ? 0.9 : 0.55}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {mapHistory.map((event, eventIndex) => {
            const px = num(event.x);
            const py = num(event.y);
            if (px === null || py === null) return null;

            const isSelected = tagId !== "" && String(event.tagId) === tagId;
            const isCurrent = isSelected && current?._id === event._id;
            const left = Math.max(0, Math.min(100, ((ox + px * scale) / width) * 100));
            const top = Math.max(0, Math.min(100, ((oy - py * scale) / height) * 100));

            return (
              <div
                key={`history-point-${event._id ?? `${event.tagId}-${event.timestamp}-${eventIndex}`}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${
                  isCurrent ? "z-30 h-8 w-8 bg-red-500" : isSelected ? "z-20 h-4 w-4 bg-red-400" : "z-10 h-3 w-3 bg-sky-500"
                }`}
                style={{ left: `${left}%`, top: `${top}%` }}
                title={`${event.tagName || `Tag ${event.tagId}`} · ${event.timestamp} · X: ${px}, Y: ${py}`}
              />
            );
          })}

          {tagId && x !== null && y !== null && current?.floorId !== undefined && String(current.floorId) === String(selectedFloorId) && (
            <div
              className="pointer-events-none absolute z-40 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-red-500 shadow-lg ring-2 ring-red-300"
              style={{
                left: `${Math.max(0, Math.min(100, ((ox + x * scale) / width) * 100))}%`,
                top: `${Math.max(0, Math.min(100, ((oy - y * scale) / height) * 100))}%`,
              }}
              title={`Current ${current.tagId} · ${x}, ${y}`}
            />
          )}
        </div>
      </div>
      <div className="border-t bg-white p-4">
        {tagId ? (
          <input
            type="range"
            min={0}
            max={Math.max(0, selectedHistory.length - 1)}
            value={Math.min(index, Math.max(0, selectedHistory.length - 1))}
            onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }}
            disabled={selectedHistory.length <= 1}
            className="w-full"
            aria-label="Selected tag history timeline"
          />
        ) : (
          <div>
            <div className="mb-2 flex justify-between text-xs text-slate-500">
              <span>All Tags History — 5 records per tag</span>
              <span>5 records per tag</span>
            </div>
            <input
              type="range"
              min={0}
              max={allHistoryMaxIndex}
              value={Math.min(allHistoryIndex, allHistoryMaxIndex)}
              onChange={(e) => { setPlaying(false); setAllHistoryIndex(Number(e.target.value)); }}
              disabled={allHistoryMaxIndex <= 0}
              className="w-full"
              aria-label="All tags history timeline"
            />
            <p className="mt-1 text-xs text-slate-400">
              Move the timeline left to see older history. Maximum 5 past records are shown for each tag.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function validFloorOptions(floors: Item[]): [string, string][] {
  return floors.flatMap((item) => { const id = floorId(item); if (id === undefined) return []; return [[String(id), str(item.name ?? item.floor_name ?? item.title, `Floor ${String(id)}`)]] as [string, string][]; });
}

function valueId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
