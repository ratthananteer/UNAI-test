// BUILDING MAP CONTROLLER + HISTORY UI:
// This component owns the Building page's floor selector and switches between
// Live Map and Tag History modes. BuildingTagHistory loads saved tag positions,
// filters them by floor/tag, draws historical paths and markers, and provides
// timeline replay. The live mode passes normalized building data to LiveMap.
//
// Tag History concept:
// - All Tags mode shows a limited history window per tag and can move backward.
// - Selected Tag mode shows that tag's past positions up to the selected time.
// - The current/default tag marker uses the Building live-map T + Tag ID style.
// - Older positions are rendered as faded shadow positions.

"use client";

import { useEffect, useMemo, useState } from "react";
import LiveMap, { type LiveMapTag } from "./LiveMap";

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

// Location-bearing tags must have an explicit floor before they are rendered
// on a floor map. Metadata records can omit floor information; treating those
// records as belonging to every floor can put a stale tag coordinate on the
// wrong map (and is especially visible when only one tag has bad coordinates).
function tagBelongsToFloor(item: Item, selectedId: string | number): boolean {
  const value = idOf(item.floor_id ?? item.floorId ?? item.floor ?? item.floorID);
  return value !== undefined && String(value) === String(selectedId);
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
  const [followedTagId, setFollowedTagId] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [selectedUserTagId, setSelectedUserTagId] = useState("");

  const getUserName = (tag: Item): string => {
    const first = str(tag.firstname ?? tag.first_name ?? tag.firstName, "").trim();
    const last = str(tag.lastname ?? tag.last_name ?? tag.lastName, "").trim();
    return [first, last].filter(Boolean).join(" ").trim() ||
      str(tag.ui_display ?? tag.label ?? tag.name ?? tag.tag_name ?? tag.tagName, "").trim() ||
      `Tag ${String(tag.id ?? tag.tagId ?? "")}`;
  };

  const searchableTags = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    if (selectedFloorId === undefined) return [];
    const candidates = tags.filter((tag: Item) => belongsToFloor(tag, selectedFloorId));
    if (!query) return candidates.slice(0, 8);
    return candidates.filter((tag: Item) => {
      const id = String(tag.id ?? tag.tagId ?? tag.tag_id ?? "");
      return getUserName(tag).toLowerCase().includes(query) || id.includes(query);
    }).slice(0, 8);
  }, [tags, selectedFloorId, userSearch]);

  const selectedUser = useMemo(() => {
    if (!selectedUserTagId) return undefined;
    return tags.find((tag: Item) => String(tag.id ?? tag.tagId ?? tag.tag_id) === selectedUserTagId);
  }, [tags, selectedUserTagId]);

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
    // UNAI floor payloads have appeared with both snake_case and camelCase
    // names. Prefer the real map dimensions/transform whenever available;
    // falling back to 1600x900 in LiveMap is only a last resort.
    map_width: num(
      floorValue("map_width") ??
        floorValue("mapWidth") ??
        floorValue("width") ??
        floorValue("map_width_px") ??
        floorValue("mapWidthPx"),
    ),
    map_height: num(
      floorValue("map_height") ??
        floorValue("mapHeight") ??
        floorValue("height") ??
        floorValue("map_height_px") ??
        floorValue("mapHeightPx"),
    ),
    pixel_meter: num(
      floorValue("pixel_meter") ??
        floorValue("pixelMeter") ??
        floorValue("pixel_per_meter") ??
        floorValue("pixels_per_meter") ??
        floorValue("pixelPerMeter"),
    ),
    origin_x: num(
      floorValue("origin_x") ??
        floorValue("originX") ??
        floorValue("map_origin_x") ??
        floorValue("mapOriginX"),
    ),
    origin_y: num(
      floorValue("origin_y") ??
        floorValue("originY") ??
        floorValue("map_origin_y") ??
        floorValue("mapOriginY"),
    ),
  };

  const liveAnchors = anchors.filter((item) => belongsToFloor(item, selectedFloorId)).map((item) => ({
    id: idOf(item.id ?? item.anchor_id ?? item.anchorId),
    x: idOf(item.x ?? item.pos_x ?? item.position_x) as number | string | null,
    y: idOf(item.y ?? item.pos_y ?? item.position_y) as number | string | null,
    label: str(item.label ?? item.name ?? item.id, "Anchor"),
    status: typeof item.status === "number" ? item.status : undefined,
  }));

  const liveTags = tags.filter((item) => tagBelongsToFloor(item, selectedFloorId));
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
          <label htmlFor="building-user-search" className="text-sm font-medium text-slate-600">
            User
          </label>
          <div className="relative">
            <input
              id="building-user-search"
              type="text"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Search user..."
              className="w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              autoComplete="off"
            />
            {userSearch.trim() && searchableTags.length > 0 && (
              <div className="absolute left-0 top-full z-[60] mt-1 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                {searchableTags.map((tag: Item) => {
                  const id = String(tag.id ?? tag.tagId ?? tag.tag_id ?? "");
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setSelectedUserTagId(id);
                        setFollowedTagId(id);
                        setTagIdFilter(id);
                        setUserSearch(getUserName(tag));
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-700">{getUserName(tag)}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-slate-400">#{id}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <label htmlFor="building-tag-filter" className="text-sm font-medium text-slate-600">
            Tag ID
          </label>
          <input
            id="building-tag-filter"
            type="text"
            inputMode="numeric"
            value={tagIdFilter}
            onChange={(event) => setTagIdFilter(event.target.value.replace(/\D/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const id = tagIdFilter.trim();
                if (id) setFollowedTagId(id);
              }
            }}
            placeholder="Tag ID"
            className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            aria-label="Enter tag ID to follow"
          />
          <button
            type="button"
            disabled={!tagIdFilter.trim()}
            onClick={() => {
              const id = tagIdFilter.trim();
              setFollowedTagId(id);
              setSelectedUserTagId(id);
              const match = tags.find((tag: Item) => String(tag.id ?? tag.tagId ?? tag.tag_id) === id);
              if (match) setUserSearch(getUserName(match));
            }}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Follow
          </button>
          {(tagIdFilter.trim() || followedTagId) && (
            <button
              type="button"
              onClick={() => { setTagIdFilter(""); setFollowedTagId(""); setUserSearch(""); setSelectedUserTagId(""); }}
              className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Show All
            </button>
          )}
          {followedTagId && (
            <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
              Following Tag {followedTagId}
            </span>
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

      {selectedUser && (
        <div className="mx-4 mb-3 rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-500">Selected User</p>
                <h3 className="mt-1 text-lg font-bold text-slate-800">{getUserName(selectedUser)}</h3>
                <p className="mt-1 text-xs text-slate-500">Tag ID: {String(selectedUser.id ?? selectedUser.tagId ?? selectedUser.tag_id ?? "—")}</p>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <span className="text-slate-500">Status <strong className={selectedUser.status === 1 ? "text-emerald-600" : "text-rose-600"}>{selectedUser.status === 1 ? "ONLINE" : "OFFLINE"}</strong></span>
                <span className="text-slate-500">Group <strong className="text-slate-700">{str(selectedUser.group_name ?? selectedUser.groupName, "—")}</strong></span>
                <span className="text-slate-500">Position <strong className="text-slate-700">X {str(selectedUser.x, "—")}, Y {str(selectedUser.y, "—")}</strong></span>
                <span className="text-slate-500">Last seen <strong className="text-slate-700">{formatLastSeenValue(selectedUser.lastSeen ?? selectedUser.last_seen ?? selectedUser.lastSeenAt)}</strong></span>
              </div>
            </div>
          </div>
        )}

        <LiveMap
        placeId={placeId}
        buildingId={buildingId}
        floor={liveFloor}
        anchors={liveAnchors}
        tags={liveTags as Parameters<typeof LiveMap>[0]["tags"]}
        tagIdFilter={followedTagId}
        onTagSelect={(tag: LiveMapTag) => {
          const id = String(tag.id ?? tag.tagId ?? tag.tag_id ?? "");
          setSelectedUserTagId(id);
          setFollowedTagId(id);
          setTagIdFilter(id);
          setUserSearch(getUserName(tag));
        }}
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
  // Delay the interactive map subtree until the first client effect. This
  // prevents browser extensions from changing form/button attributes between
  // the server HTML and React hydration (for example `fdprocessedid`).
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  if (!mounted) {
    return (
      <section className="mt-6 overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="flex min-h-20 items-center justify-center border-b p-4">
          <span className="text-sm text-slate-500">Loading building map...</span>
        </div>
        <div className="min-h-24" />
      </section>
    );
  }

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
        <BuildingTagHistory buildingId={buildingId} floors={floors} tags={tags} zones={zones} selectedFloorId={selectedFloorId} onFloorChange={setSelectedFloorId} />
      )}
    </section>
  );
}

function BuildingTagHistory({
  buildingId,
  floors,
  tags,
  zones,
  selectedFloorId,
  onFloorChange,
}: {
  buildingId: string | number;
  floors: Item[];
  tags: Item[];
  zones: Item[];
  selectedFloorId?: string | number;
  onFloorChange: (id: string | number) => void;
}) {
  type HistoryEvent = { _id?: string; tagId?: string | number; tagName?: string | null; floorId?: string | number | null; x?: number | null; y?: number | null; timestamp: string; event?: string };
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [tagId, setTagId] = useState("");

  const tagNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const tag of tags) {
      const id = tag.id ?? tag.tagId ?? tag.tag_id;
      if (id == null) continue;
      const first = str(tag.firstname ?? tag.first_name ?? tag.firstName, "").trim();
      const last = str(tag.lastname ?? tag.last_name ?? tag.lastName, "").trim();
      const name = [first, last].filter(Boolean).join(" ").trim() ||
        str(tag.ui_display ?? tag.label ?? tag.name ?? tag.tag_name ?? tag.tagName, "").trim();
      if (name) map.set(String(id), name);
    }
    return map;
  }, [tags]);

  function userNameOf(event: HistoryEvent): string {
    return tagNames.get(String(event.tagId ?? "")) || event.tagName || String(event.tagId ?? "");
  }
  const [followedTagId, setFollowedTagId] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [allHistoryIndex, setAllHistoryIndex] = useState(0);
  const ALL_HISTORY_VISIBLE = 10;

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

  // Aggregate recorded positions into small floor-coordinate cells. Higher
  // counts mean the tag(s) spent more recorded samples in that area.
  const heatmapPoints = useMemo(() => {
    if (!showHeatmap) return [];
    const bins = new Map<string, { x: number; y: number; count: number }>();
    const binSize = 20;

    for (const event of history) {
      if (event.x == null || event.y == null || event.floorId == null) continue;
      if (selectedFloorId == null || String(event.floorId) !== String(selectedFloorId)) continue;
      if (tagId && String(event.tagId ?? "") !== tagId) continue;
      const x = num(event.x);
      const y = num(event.y);
      if (x === null || y === null) continue;
      const bx = Math.floor(x / binSize) * binSize + binSize / 2;
      const by = Math.floor(y / binSize) * binSize + binSize / 2;
      const key = `${bx}:${by}`;
      const existing = bins.get(key);
      if (existing) existing.count += 1;
      else bins.set(key, { x: bx, y: by, count: 1 });
    }

    const maxCount = Math.max(1, ...Array.from(bins.values()).map((point) => point.count));
    return Array.from(bins.values()).map((point) => ({
      ...point,
      intensity: point.count / maxCount,
    }));
  }, [history, selectedFloorId, tagId, showHeatmap]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/tag-events?buildingId=${encodeURIComponent(String(buildingId))}&limit=500`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setEvents(Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []);
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
        <input
          value={followedTagId}
          onChange={(e) => setFollowedTagId(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter") setTagId(followedTagId.trim()); }}
          placeholder="Tag ID"
          inputMode="numeric"
          className="w-28 rounded-lg border px-3 py-2 text-sm"
          aria-label="Enter tag ID to follow"
        />
        <button type="button" disabled={!followedTagId.trim()} onClick={() => setTagId(followedTagId.trim())} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">Follow</button>
        {tagId && <button type="button" onClick={() => { setTagId(""); setFollowedTagId(""); }} className="rounded-lg border px-3 py-2 text-sm">Show All</button>}
        <select value={tagId} onChange={(e) => { setTagId(e.target.value); setFollowedTagId(e.target.value); setIndex(0); setPlaying(false); }} className="rounded-lg border px-3 py-2 text-sm" aria-label="Select one tag">
          <option value="">All Tags — show all history</option>
          {Array.from(new Map(events.filter((e) => e.tagId !== undefined).map((e) => [String(e.tagId), `${tagNames.get(String(e.tagId)) || e.tagName || `Tag ${e.tagId}`} (${e.tagId})`])).entries()).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setShowHeatmap((value) => !value)}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${showHeatmap ? "bg-orange-500 text-white" : "border bg-white text-slate-700"}`}
        >
          {showHeatmap ? "Hide Heatmap" : "Heatmap"}
        </button>
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

          {showHeatmap && heatmapPoints.map((point) => {
            const left = ((ox + point.x * scale) / width) * 100;
            const top = ((oy - point.y * scale) / height) * 100;
            const size = 24 + point.intensity * 44;
            return (
              <span
                key={`heat-${point.x}-${point.y}`}
                className="pointer-events-none absolute z-[2] -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500/30 blur-md"
                style={{
                  left: `${Math.max(0, Math.min(100, left))}%`,
                  top: `${Math.max(0, Math.min(100, top))}%`,
                  width: `${size}px`,
                  height: `${size}px`,
                  opacity: 0.25 + point.intensity * 0.65,
                }}
                title={`${point.count} position records`}
              />
            );
          })}

          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
            {zones.filter((zone) => { const zid = valueId(zone.floor_id ?? zone.floorId ?? zone.floorID); return zid === undefined || String(zid) === String(selectedFloorId); }).map((zone, zi) => {
              const points = polygon(zone.polygon_data).map((point: unknown) => { if (!Array.isArray(point) || point.length < 2) return null; const px = num(point[0]); const py = num(point[1]); if (px === null || py === null) return null; return `${ox + px * scale},${oy - py * scale}`; }).filter((v: string | null): v is string => v !== null).join(" ");
              if (!points) return null; const color = typeof zone.zone_color === "string" ? zone.zone_color : "#5dc6ba";
              return <polygon key={String(zone.id ?? zi)} points={points} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
            })}
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
                ? "#0ea5e9"
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
          </svg>

          {mapHistory.map((event, eventIndex) => {
            const px = num(event.x);
            const py = num(event.y);
            if (px === null || py === null) return null;

            const isSelected = tagId !== "" && String(event.tagId) === tagId;
            const tagEvents = historyByTag.find(([id]) => id === String(event.tagId))?.[1] ?? [];
            const isLatestVisible = tagEvents[tagEvents.length - 1] === event;
            const isCurrent = isSelected && current?._id === event._id;
            const isPastShadow = !isCurrent && !isLatestVisible;
            const left = Math.max(0, Math.min(100, ((ox + px * scale) / width) * 100));
            const top = Math.max(0, Math.min(100, ((oy - py * scale) / height) * 100));
            const displayUserName = userNameOf(event);

            return (
              <div
                key={`history-point-${event._id ?? `${event.tagId}-${event.timestamp}-${eventIndex}`}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center transition-all duration-150 ${
                  isCurrent ? "z-40" : isLatestVisible ? "z-30" : "z-10"
                }`}
                style={{ left: `${left}%`, top: `${top}%` }}
                title={`${displayUserName} · ${isPastShadow ? "Past position" : isCurrent ? "Current position" : "Latest position"} · ${event.timestamp} · X: ${px}, Y: ${py}`}
              >
                <div
                  className={`flex items-center justify-center rounded-full border-2 border-white font-bold text-white shadow-lg ${
                    isCurrent
                      ? "h-8 min-w-8 bg-sky-600 px-2 text-[9px] ring-2 ring-sky-300"
                      : isPastShadow
                        ? "h-5 min-w-5 bg-sky-500/20 px-1 text-[7px] opacity-45 shadow-[0_0_10px_rgba(14,165,233,0.25)]"
                        : "h-8 min-w-8 bg-sky-600 px-2 text-[9px]"
                  }`}
                >
                  {isPastShadow ? "" : "T"}
                </div>
                {!isPastShadow && (
                  <span className={`mt-1 max-w-28 truncate rounded bg-white/95 px-1.5 py-0.5 font-semibold text-slate-700 shadow ${
                    isCurrent ? "text-[10px] text-sky-700" : "text-[9px]"
                  }`}>
                    {displayUserName}
                  </span>
                )}
              </div>
            );
          })}

          {tagId && x !== null && y !== null && current?.floorId !== undefined && String(current.floorId) === String(selectedFloorId)  
            }
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
              <span>All Tags History — 10 records per tag</span>
              <span>10 records per tag</span>
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
              Move the timeline left to see older history. Maximum 10 past records are shown for each tag.
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

function formatLastSeenValue(value: unknown): string {
  if (!value) return "Never";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return date.toLocaleString();
}

function valueId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
