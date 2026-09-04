// LIVE RTLS MAP
// Displays the current floor image, zones, anchors, active tags and realtime data.
// UNAI Socket.IO is owned by lib/unaiRealtime. This component intentionally has
// no direct Socket.IO connection or reconnect timer.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeUnaiRealtime } from "../../lib/unaiRealtime";

type Floor = {
  id?: number | string;
  name?: string;
  map_path?: string | null;
  map_width?: number | null;
  map_height?: number | null;
  pixel_meter?: number | null;
  origin_x?: number | null;
  origin_y?: number | null;
};

type Anchor = {
  id?: number | string;
  x?: number | string | null;
  y?: number | string | null;
  label?: string;
  status?: number;
};

export type LiveMapTag = Record<string, unknown> & {
  id?: number | string;
  floor_id?: number | string;
  building?: number | string;
  buildingId?: number | string;
  floor?: number | string;
  tagId?: number | string;
  x?: number | string | null;
  y?: number | string | null;
  z?: number | string | null;
  label?: string;
  name?: string;
  status?: number;
  group_name?: string;
  group_id?: number | string;
  firstname?: string;
  lastname?: string;
};

type Tag = LiveMapTag;
type TagGroup = { groupName: string; members: Tag[] };

type TimelineEvent = {
  id: string;
  tagId: string;
  tagName: string;
  event: string;
  x: number;
  y: number;
  timestamp: string;
};

type Zone = {
  id?: number | string;
  name?: string;
  polygon_data?: string | null;
  zone_color?: string | null;
};

type SocketState = "loading" | "connecting" | "connected" | "error" | "disconnected";

function numberValue(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameId(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

function isAssetTag(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const usageType =
    item.usage_type ??
    item.usageType ??
    (item.usage && typeof item.usage === "object"
      ? (item.usage as Record<string, unknown>).type
      : undefined);
  return String(usageType ?? "").trim().toUpperCase() === "ASSET";
}

function collectObjects(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output));
    return output;
  }

  const object = value as Record<string, unknown>;
  output.push(object);
  [
    object.data,
    object.item,
    object.result,
    object.payload,
    object.tag,
    object.tags,
    object.location,
    object.positions,
  ].forEach((child) => {
    if (child && typeof child === "object") collectObjects(child, output);
  });
  return output;
}

function findTagUpdates(
  payload: unknown,
  eventName: string,
  floorId: unknown,
  assetTagIds: Set<string>,
): Tag[] {
  const updates: Tag[] = [];

  for (const object of collectObjects(payload)) {
    if (isAssetTag(object)) continue;

    const rawTagId = object.tagId ?? object.tag_id ?? object.tagID ?? object.id;
    if (rawTagId === undefined || rawTagId === null) continue;
    if (assetTagIds.has(String(rawTagId))) continue;

    const x = numberValue(object.x ?? object.pos_x ?? object.position_x ?? object.location_x);
    const y = numberValue(object.y ?? object.pos_y ?? object.position_y ?? object.location_y);
    if (x === null || y === null) continue;

    const payloadFloor = object.floorId ?? object.floor_id ?? object.floor ?? object.floorID;
    if (payloadFloor !== undefined && !sameId(payloadFloor, floorId)) continue;

    const resolvedFloorId = payloadFloor !== undefined ? payloadFloor : floorId;
    const normalizedFloorId =
      typeof resolvedFloorId === "string" || typeof resolvedFloorId === "number"
        ? resolvedFloorId
        : undefined;

    updates.push({
      ...object,
      id: rawTagId as number | string,
      tagId: rawTagId as number | string,
      floor_id: normalizedFloorId,
      x,
      y,
      _socketEvent: eventName,
      _eventTimestamp:
        object.timestamp ??
        object.time ??
        object.unix_time ??
        object.unixTime ??
        object.lastSeenAt ??
        object.date_now ??
        object.created_at,
    });
  }

  return updates;
}

function imageUrl(path: unknown): string | null {
  if (!path) return null;
  const value = String(path);
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://rtls.lailab.online/${value.replace(/^\//, "")}`;
}

function toPixel(realX: number, realY: number, floor: Floor): { px: number; py: number } {
  const scale = numberValue(floor.pixel_meter) ?? 1;
  const originX = numberValue(floor.origin_x) ?? 0;
  const originY = numberValue(floor.origin_y) ?? 0;
  return { px: originX + realX * scale, py: originY - realY * scale };
}

// Keep a marker inside the rendered floor image. UNAI can occasionally send a
// stale/noisy coordinate slightly outside the floor boundary. We do not change
// the stored X/Y; this only protects the UI position from escaping the map.
function mapPosition(realX: number, realY: number, floor: Floor, width: number, height: number) {
  const { px, py } = toPixel(realX, realY, floor);
  if (!Number.isFinite(px) || !Number.isFinite(py) || width <= 0 || height <= 0) return null;

  // Allow a small coordinate tolerance so a marker does not visibly jump when
  // it is only a few pixels beyond an image edge, then clamp it to the image.
  const toleranceX = width * 0.05;
  const toleranceY = height * 0.05;
  if (px < -toleranceX || px > width + toleranceX || py < -toleranceY || py > height + toleranceY) {
    return null;
  }

  return {
    px: Math.max(0, Math.min(width, px)),
    py: Math.max(0, Math.min(height, py)),
  };
}

function parsePolygon(value: unknown): [number, number][] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed?.polygon) ? parsed.polygon : [];
  } catch {
    return [];
  }
}

export type LiveMapProps = {
  placeId: number | string;
  buildingId: number | string;
  floor: Floor;
  anchors: Anchor[];
  tags: Tag[];
  tagIdFilter?: string;
  onTagSelect?: (tag: Tag) => void;
  zones: Zone[];
};

export default function LiveMap({
  placeId,
  buildingId,
  floor,
  anchors,
  tags: initialTags,
  tagIdFilter = "",
  onTagSelect,
  zones,
}: LiveMapProps) {
  const [tags, setTags] = useState<Tag[]>(() => initialTags.filter((tag) => !isAssetTag(tag)));
  const [showAnchors, setShowAnchors] = useState(true);
  const [socketState, setSocketState] = useState<SocketState>("loading");
  const [socketInfo, setSocketInfo] = useState("Loading realtime tag data...");
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const messageCountRef = useRef(0);
  const messageCountTimerRef = useRef<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeTagCheckReady, setActiveTagCheckReady] = useState(false);
  // Socket packets can arrive much faster than React needs to render. Keep a
  // compact signature per tag so duplicate/unchanged packets do not rebuild
  // the entire map, including the SVG zone layer.
  const tagRenderSignatureRef = useRef<Map<string, string>>(new Map());
  const pendingTagUpdatesRef = useRef<Map<string, Tag>>(new Map());
  const tagFlushFrameRef = useRef<number | null>(null);
  const assetTagIdsRef = useRef<Set<string>>(new Set());
  const assetTagIdsReadyRef = useRef(false);
  // Do not accept backend active-tag data until the authoritative Asset ID
  // denylist has loaded. Socket payloads can omit usage_type, so this guard
  // prevents an Asset from briefly appearing during startup.

  // Keep initial/API tags available immediately, but never allow an Asset into state.
  useEffect(() => {
    const safeInitialTags = initialTags.filter((tag) => !isAssetTag(tag));
    setTags(safeInitialTags);
    setActiveTagIds(
      new Set(
        safeInitialTags
          .map((tag) => String(tag.id ?? tag.tagId ?? tag.tag_id ?? ""))
          .filter(Boolean),
      ),
    );
    // activeTagCheckReady is intentionally controlled by the Asset denylist
    // loader below, not by initial API data.
  }, [initialTags, floor.id]);

  function getStringField(tag: Tag, ...keys: string[]): string {
    for (const key of keys) {
      const value = tag[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  }

  function buildTagGroups(tagList: Tag[]): TagGroup[] {
    const groups = new Map<string, Tag[]>();
    for (const tag of tagList) {
      if (isAssetTag(tag)) continue;
      const groupName =
        getStringField(tag, "group_name", "groupName", "group", "group_name_en") ||
        "Ungrouped";
      const members = groups.get(groupName) ?? [];
      members.push(tag);
      groups.set(groupName, members);
    }
    return Array.from(groups.entries()).map(([groupName, members]) => ({ groupName, members }));
  }

  function eventTime(value: unknown): string {
    if (typeof value === "number") {
      const date = new Date(value < 100000000000 ? value * 1000 : value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return new Date().toISOString();
  }

  async function saveTagEvents(updates: Tag[], eventName: string): Promise<void> {
    const safeUpdates = updates.filter((tag) => !isAssetTag(tag));
    if (!safeUpdates.length) return;

    const events = safeUpdates.map((tag) => ({
      tagId: String(tag.id ?? tag.tagId ?? tag.tag_id),
      buildingId: String(tag.building ?? tag.buildingId ?? buildingId),
      floorId: String(tag.floor ?? tag.floor_id ?? tag.floorId ?? floor.id),
      groupId: tag.group_id ?? null,
      groupName: tag.group_name ?? null,
      tagName: tag.ui_display ?? tag.label ?? tag.name ?? null,
      event: eventName || "position_update",
      x: Number(tag.x),
      y: Number(tag.y),
      z: numberValue(tag.z),
      timestamp: eventTime(tag._eventTimestamp ?? tag.timestamp),
      rawData: tag,
    }));

    try {
      const response = await fetch("/api/tag-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          result && typeof result === "object" && "error" in result
            ? String((result as { error?: unknown }).error ?? `HTTP ${response.status}`)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
    } catch (error) {
      console.error("[MongoDB] Failed to save tag event:", error);
    }
  }

  function addTimelineEvents(updates: Tag[], eventName: string): void {
    const newEvents: TimelineEvent[] = updates
      .filter((tag) => !isAssetTag(tag))
      .map((tag) => {
        const tagId = String(tag.id ?? tag.tagId ?? "unknown");
        const tagName = getStringField(tag, "label", "name", "tag_name", "tagName") || `Tag ${tagId}`;
        return {
          id: `${tagId}-${eventTime(tag._eventTimestamp)}-${Date.now()}`,
          tagId,
          tagName,
          event: eventName,
          x: Number(tag.x),
          y: Number(tag.y),
          timestamp: eventTime(tag._eventTimestamp),
        };
      });

    if (newEvents.length) setTimeline((current) => [...newEvents, ...current].slice(0, 100));
  }

  // Active-tag polling. This is a browser interval, so its type is the return
  // type of window.setInterval and it is always cleared only after null-checking.
  useEffect(() => {
    let cancelled = false;
    let activePollTimer: number | null = null;

    async function checkActiveTags(): Promise<void> {
      // The active-tag API may contain a tag whose Socket payload has no
      // usage_type. Wait until we have the authoritative Asset ID denylist.
      if (!assetTagIdsReadyRef.current) return;

      try {
        const response = await fetch(
          `/api/active-tags?buildingId=${encodeURIComponent(String(buildingId))}&floorId=${encodeURIComponent(String(floor.id))}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data: unknown = await response.json();
        if (cancelled) return;

        const activeRaw =
          data && typeof data === "object" && Array.isArray((data as { tags?: unknown }).tags)
            ? (data as { tags: unknown[] }).tags
            : [];
        const active = activeRaw.filter((tag): tag is Record<string, unknown> => !isAssetTag(tag));
        const ids = new Set<string>();

        for (const raw of active) {
          const tagId = raw.tagId ?? raw.id;
          if (tagId === undefined || tagId === null) continue;
          const id = String(tagId);
          if (!assetTagIdsRef.current.has(id)) ids.add(id);
        }

        // The active-tags endpoint is status-only here. Do not overwrite
        // socket positions with its (older) coordinates; doing so every 2s
        // makes markers visibly jump.
        setActiveTagIds((current) => {
          if (current.size === ids.size && [...current].every((id) => ids.has(id))) return current;
          return ids;
        });
        setActiveTagCheckReady(true);
      } catch (error) {
        if (!cancelled) console.error("[TagMonitor] Active tag check failed:", error);
      }
    }

    void checkActiveTags();
    activePollTimer = window.setInterval(() => {
      void checkActiveTags();
    }, 10000);

    return () => {
      cancelled = true;
      if (activePollTimer !== null) {
        window.clearInterval(activePollTimer);
        activePollTimer = null;
      }
    };
  }, [buildingId, floor.id]);

  // Load authoritative Asset IDs first, then subscribe to the shared realtime manager.
  // This avoids the race where a Socket location payload has no usage_type.
  useEffect(() => {
    let cancelled = false;
    assetTagIdsReadyRef.current = false;
    setActiveTagCheckReady(false);
    let unsubscribeRealtime: (() => void) | null = null;
    let backendPollTimer: number | null = null;

    async function loadAssetTagIds(): Promise<boolean> {
      try {
        const response = await fetch("/api/tag?mode=asset-ids", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (cancelled) return false;

        const rawIds =
          data && typeof data === "object" && Array.isArray((data as { assetTagIds?: unknown }).assetTagIds)
            ? (data as { assetTagIds: unknown[] }).assetTagIds
            : [];
        const ids = new Set(rawIds.map((id) => String(id)).filter(Boolean));
        assetTagIdsRef.current = ids;
        assetTagIdsReadyRef.current = true;
        setTags((current) => current.filter((tag) => !isAssetTag(tag) && !ids.has(String(tag.id ?? tag.tagId ?? tag.tag_id))));
        setActiveTagIds((current) => new Set([...current].filter((id) => !ids.has(id))));
        setActiveTagCheckReady(true);
        console.log(`[UNAI TAG] Asset denylist loaded: ${ids.size} tag(s)`);
        return true;
      } catch (error) {
        assetTagIdsReadyRef.current = false;
        setActiveTagCheckReady(false);
        console.error("[UNAI TAG] Failed to load Asset denylist:", error);
        return false;
      }
    }

    async function startRealtime(): Promise<void> {
      const loaded = await loadAssetTagIds();
      if (cancelled) return;

      // Direct payload filtering still protects us when metadata is present.
      // If the authoritative list cannot be loaded, do not create a second
      // Socket.IO connection; the shared realtime manager remains the only owner.
      if (!loaded) {
        setSocketState("error");
        setSocketInfo("Could not load Asset metadata; realtime subscription was not started.");
        return;
      }

      unsubscribeRealtime = subscribeUnaiRealtime({
        placeId,
        buildingId,
        floorId: floor.id ?? "",
        onStatus: ({ state, message, socketId }) => {
          if (state === "connected") {
            setSocketState("connected");
            setSocketInfo(socketId ? `${message} Socket: ${socketId}` : message);
          } else if (state === "connecting") {
            setSocketState("connecting");
            setSocketInfo(message);
          } else if (state === "rate_limited" || state === "error") {
            setSocketState("error");
            setSocketInfo(message);
          } else {
            setSocketState("disconnected");
            setSocketInfo(message);
          }
        },
        onTag: ({ payload, eventName }) => {
          const updates = findTagUpdates(payload, eventName, floor.id, assetTagIdsRef.current);
          if (!updates.length) return;

          // Socket traffic can be much faster than React rendering. Keep only
          // the newest position for each tag and flush once per animation frame.
          // This prevents a burst of socket packets from rebuilding the entire
          // tag array repeatedly and keeps marker motion visually smooth.
          const changedUpdates = updates.filter((update) => {
            const tagId = update.id ?? update.tagId ?? update.tag_id;
            if (tagId == null || isAssetTag(update) || assetTagIdsRef.current.has(String(tagId))) return false;
            const id = String(tagId);
            const signature = [
              update.x ?? "",
              update.y ?? "",
              update.z ?? "",
              update.floor_id ?? update.floorId ?? floor.id,
              update.status ?? "",
            ].join("|");
            if (tagRenderSignatureRef.current.get(id) === signature) return false;
            tagRenderSignatureRef.current.set(id, signature);
            return true;
          });

          if (!changedUpdates.length) return;

          changedUpdates.forEach((update) => {
            const id = String(update.id ?? update.tagId ?? update.tag_id);
            pendingTagUpdatesRef.current.set(id, update);
          });

          // History persistence remains immediate so a UI performance
          // optimization never silently drops historical socket positions.
          void saveTagEvents(changedUpdates, eventName);

          if (tagFlushFrameRef.current === null) {
            tagFlushFrameRef.current = window.requestAnimationFrame(() => {
              tagFlushFrameRef.current = null;
              const batched = Array.from(pendingTagUpdatesRef.current.values());
              pendingTagUpdatesRef.current.clear();
              if (!batched.length) return;

              setTags((current) => {
                const next = [...current];
                for (const update of batched) {
                  const tagId = update.id ?? update.tagId ?? update.tag_id;
                  if (tagId === undefined || tagId === null) continue;
                  const index = next.findIndex((tag) => sameId(tag.id ?? tag.tagId ?? tag.tag_id, tagId));
                  if (index >= 0) next[index] = { ...next[index], ...update };
                  else next.push(update);
                }
                return next.filter((tag) => !isAssetTag(tag) && !assetTagIdsRef.current.has(String(tag.id ?? tag.tagId ?? tag.tag_id)));
              });

              setActiveTagIds((current) => {
                const next = new Set(current);
                batched.forEach((tag) => {
                  const id = tag.id ?? tag.tagId ?? tag.tag_id;
                  if (id !== undefined && id !== null && !assetTagIdsRef.current.has(String(id))) next.add(String(id));
                });
                return next;
              });

              addTimelineEvents(batched, eventName);
              setLastUpdate(new Date().toLocaleTimeString());
            });
          }

          messageCountRef.current += 1;
          if (messageCountTimerRef.current === null) {
            messageCountTimerRef.current = window.setTimeout(() => {
              messageCountTimerRef.current = null;
              setMessageCount(messageCountRef.current);
            }, 500);
          }
        },
      });

      // Backend polling remains as a resilience path, but does not open sockets.
      const pollBackend = async (): Promise<void> => {
        try {
          const response = await fetch(
            `/api/active-tags?buildingId=${encodeURIComponent(String(buildingId))}&floorId=${encodeURIComponent(String(floor.id))}`,
            { cache: "no-store" },
          );
          if (!response.ok || cancelled) return;
          const data: unknown = await response.json();
          const raw =
            data && typeof data === "object" && Array.isArray((data as { tags?: unknown }).tags)
              ? (data as { tags: unknown[] }).tags
              : [];
          const active = raw.filter((tag): tag is Record<string, unknown> => !isAssetTag(tag));
          if (!active.length) return;

          const ids = new Set<string>();
          for (const item of active) {
            const tagId = item.tagId ?? item.id;
            if (tagId != null && !assetTagIdsRef.current.has(String(tagId))) {
              ids.add(String(tagId));
            }
          }
          // Polling supplies liveness only. Socket remains authoritative for
          // coordinates, so this cannot move a marker backwards.
          setActiveTagIds((current) => {
            if (current.size === ids.size && [...current].every((id) => ids.has(id))) return current;
            return ids;
          });
        } catch (error) {
          if (!cancelled) console.error("[UNAI RTLS] Backend realtime check failed:", error);
        }
      };

      void pollBackend();
      // Liveness is not a render loop. Ten seconds is enough for the
      // TagMonitor timeout while keeping the map free from periodic state
      // churn. Socket packets remain the source of coordinates.
      backendPollTimer = window.setInterval(() => {
        void pollBackend();
      }, 10000);
    }

    void startRealtime();

    return () => {
      cancelled = true;
      assetTagIdsReadyRef.current = false;
      pendingTagUpdatesRef.current.clear();
      if (tagFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(tagFlushFrameRef.current);
        tagFlushFrameRef.current = null;
      }
      if (messageCountTimerRef.current !== null) {
        window.clearTimeout(messageCountTimerRef.current);
        messageCountTimerRef.current = null;
      }
      setActiveTagCheckReady(false);
      if (backendPollTimer !== null) {
        window.clearInterval(backendPollTimer);
        backendPollTimer = null;
      }
      if (unsubscribeRealtime) {
        unsubscribeRealtime();
        unsubscribeRealtime = null;
      }
    };
  }, [placeId, buildingId, floor.id]);

  const stableZones = useMemo(
    () => zones.map((zone) => ({
      ...zone,
      parsedPolygon: parsePolygon(zone.polygon_data),
    })),
    [zones],
  );

  const visibleTags = useMemo(() => {
    if (!activeTagCheckReady) return [];
    const filter = tagIdFilter.trim();
    const activeTags = tags.filter((tag) => {
      const id = String(tag.id ?? tag.tagId ?? tag.tag_id ?? "");
      return Boolean(id) && activeTagIds.has(id) && !isAssetTag(tag) && !assetTagIdsRef.current.has(id);
    });
    if (!filter) return activeTags;
    return activeTags.filter((tag) => String(tag.id ?? tag.tagId ?? tag.tag_id ?? "") === filter);
  }, [tags, activeTagIds, activeTagCheckReady, tagIdFilter]);

  const socketTagGroups = useMemo(() => buildTagGroups(visibleTags), [visibleTags]);

  const statusClass = useMemo(() => {
    if (socketState === "connected") return "bg-emerald-100 text-emerald-700";
    if (socketState === "connecting" || socketState === "loading") return "bg-amber-100 text-amber-700";
    return "bg-rose-100 text-rose-700";
  }, [socketState]);

  const width = numberValue(floor.map_width) ?? 1600;
  const height = numberValue(floor.map_height) ?? 900;
  const map = imageUrl(floor.map_path);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 text-xs">
        <span className={`rounded-full px-3 py-1 font-bold ${statusClass}`}>
          {socketState === "connected" ? "● LIVE" : socketState.toUpperCase()}
        </span>
        <span className="text-slate-500">{socketInfo}</span>
        <span className="ml-auto text-slate-400">
          Socket events: {messageCount}{lastUpdate ? ` · Last tag update ${lastUpdate}` : ""}
        </span>
      </div>

      <div className="overflow-auto bg-slate-100 p-4">
        <div
          className="relative mx-auto overflow-hidden rounded-2xl border border-slate-200 bg-white"
          style={{ aspectRatio: `${width}/${height}`, maxWidth: "1000px" }}
        >
          {map ? (
            <img src={map} alt={`Map of ${String(floor.name ?? "floor")}`} className="absolute inset-0 h-full w-full object-fill" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">No floor map image</div>
          )}

          {stableZones.map((zone) => {
            const rawPolygon = zone.parsedPolygon;
            if (rawPolygon.length < 3) return null;
            const points = rawPolygon
              .map(([x, y]) => {
                const p = toPixel(x, y, floor);
                return `${(p.px / width) * 100}% ${(p.py / height) * 100}%`;
              })
              .join(", ");
            return (
              <div
                key={`zone-${String(zone.id)}`}
                className="absolute border-2"
                title={String(zone.name ?? `Zone ${zone.id ?? ""}`)}
                style={{
                  inset: 0,
                  clipPath: `polygon(${points})`,
                  background: zone.zone_color ? `${zone.zone_color}30` : "rgba(139,92,246,.12)",
                  borderColor: zone.zone_color ?? "#8b5cf6",
                  pointerEvents: "none",
                }}
              />
            );
          })}

          <div className="absolute inset-0 z-20 pointer-events-none">
            <button
              type="button"
              onClick={() => setShowAnchors((current) => !current)}
              aria-pressed={showAnchors}
              aria-label={showAnchors ? "Hide anchors" : "Show anchors"}
              className={`pointer-events-auto absolute right-3 top-3 z-50 flex cursor-pointer items-center gap-2 rounded-full border-2 px-3 py-2 text-xs font-bold shadow-md backdrop-blur transition-all duration-200 ${
                showAnchors
                  ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600"
                  : "border-red-500 bg-red-500 text-white hover:bg-red-600"
              }`}
            >
              <span>Anchors</span>
              <span className={`rounded-full bg-white px-2 py-0.5 font-extrabold ${showAnchors ? "text-emerald-600" : "text-red-600"}`}>
                {showAnchors ? "ON" : "OFF"}
              </span>
            </button>

            {showAnchors && (
              <div className="absolute inset-0">
                {anchors.map((anchor) => {
                  const realX = numberValue(anchor.x);
                  const realY = numberValue(anchor.y);
                  if (realX === null || realY === null) return null;
                  const position = mapPosition(realX, realY, floor, width, height);
                  if (!position) return null;
                  const { px, py } = position;
                  return (
                    <div
                      key={`anchor-${String(anchor.id)}`}
                      title={String(anchor.label ?? anchor.id ?? "Anchor")}
                      className={`absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[9px] font-bold text-white shadow-lg ${anchor.status === 1 ? "bg-emerald-500" : "bg-rose-500"}`}
                      style={{ left: `${(px / width) * 100}%`, top: `${(py / height) * 100}%` }}
                    >
                      A
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {visibleTags.map((tag) => {
            const realX = numberValue(tag.x);
            const realY = numberValue(tag.y);
            if (realX === null || realY === null) return null;
            const position = mapPosition(realX, realY, floor, width, height);
            if (!position) return null;
            const { px, py } = position;
            const tagName = String(tag.label ?? tag.name ?? tag.ui_display ?? `Tag ${tag.id ?? ""}`);
            return (
              <button
                key={`tag-${String(tag.id ?? tag.tagId)}`}
                type="button"
                onClick={() => onTagSelect?.(tag)}
                title={`${tagName} · X: ${realX} · Y: ${realY}`}
                className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-[left,top] duration-75 will-change-[left,top]"
                style={{ left: `${(px / width) * 100}%`, top: `${(py / height) * 100}%` }}
              >
                <div className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-sky-600 px-1 text-[9px] font-bold text-white shadow-lg">T</div>
                <span className="mt-1 max-w-28 truncate rounded bg-white/95 px-1.5 py-0.5 text-[8px] font-semibold text-slate-700 shadow">{tagName}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">Tag Groups</h2>
            <p className="text-xs text-slate-400">Grouped from realtime tag data supplied by the backend</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {socketTagGroups.length} group{socketTagGroups.length === 1 ? "" : "s"}
          </span>
        </div>

        {socketTagGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-400">
            Waiting for tag data from backend...
          </div>
        ) : (
          <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
            {socketTagGroups.map((group) => (
              <div key={group.groupName} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="min-w-0 truncate text-xs font-bold text-slate-800">{group.groupName}</h3>
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">{group.members.length}</span>
                </div>
                <div className="mt-1 max-h-24 space-y-1 overflow-y-auto pr-1">
                  {group.members.map((tag, index) => {
                    const firstname = getStringField(tag, "firstname", "first_name", "firstName");
                    const lastname = getStringField(tag, "lastname", "last_name", "lastName");
                    const fullName = `${firstname} ${lastname}`.trim();
                    const tagName = getStringField(tag, "label", "name", "tag_name", "tagName");
                    const tagId = tag.id ?? tag.tagId ?? tag.tag_id ?? index;
                    return (
                      <div key={String(tagId)} className="rounded-md border border-white bg-white px-2 py-1 shadow-sm">
                        <p className="truncate text-[10px] font-semibold text-slate-700">{fullName || tagName || `Tag ${String(tagId)}`}</p>
                        <p className="mt-0.5 truncate text-[9px] text-slate-400">
                          {tagName && fullName ? `${tagName} · ` : ""}Tag ID: {String(tagId)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
