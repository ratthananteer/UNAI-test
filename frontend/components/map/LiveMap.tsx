// LIVE RTLS MAP:
// Displays the current floor image, zones, anchors, and active tags.
// It periodically asks the backend which tags are still active and connects
// to UNAI RTLS Socket.IO for real-time position updates. Socket events are
// normalized, shown on the map, grouped in the UI, and saved to MongoDB so the
// Building Tag History feature can replay them later.

"use client";

import { useEffect, useMemo, useState } from "react";

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

type Tag = Record<string, unknown> & {
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

type TagGroup = {
  groupName: string;
  members: Tag[];
};

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

type SocketLike = {
  id?: string;
  connected?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
  onAny?: (handler: (event: string, ...args: any[]) => void) => void;
  offAny?: (handler: (event: string, ...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  disconnect: () => void;
};

// Keep one browser Socket.IO connection per floor. This is important in
// Next.js development because React Strict Mode mounts/effect-cleans/mounts a
// client component again. Creating a new UNAI connection on every effect run
// can trip UNAI's connection-attempt rate limiter even when the user only
// opened the page once.
let sharedSocket: SocketLike | null = null;
let sharedSocketKey = "";
let sharedSocketDisconnectTimer: number | null = null;
let sharedSocketRateLimitedUntil = 0;
let sharedSocketTokenPromise: Promise<string> | null = null;
let sharedSocketTokenKey = "";

const SOCKET_RATE_LIMIT_COOLDOWN_MS = 60_000;
const SOCKET_CLEANUP_GRACE_MS = 1_500;

function numberValue(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameId(a: unknown, b: unknown) {
  return String(a) === String(b);
}

function imageUrl(path: unknown) {
  if (!path) return null;
  const value = String(path);
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://rtls.lailab.online/${value.replace(/^\//, "")}`;
}

function toPixel(realX: number, realY: number, floor: Floor) {
  const scale = numberValue(floor.pixel_meter) ?? 1;
  const originX = numberValue(floor.origin_x) ?? 0;
  const originY = numberValue(floor.origin_y) ?? 0;
  return { px: originX + realX * scale, py: originY - realY * scale };
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

function collectObjects(value: unknown, output: Record<string, unknown>[] = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output));
    return output;
  }

  const object = value as Record<string, unknown>;
  output.push(object);
  [object.data, object.item, object.result, object.payload, object.tag, object.tags, object.location, object.positions]
    .forEach((child) => {
      if (child && typeof child === "object") collectObjects(child, output);
    });
  return output;
}

function findTagUpdates(
  payload: unknown,
  eventName: string,
  floorId: unknown
): Tag[] {
  const objects = collectObjects(payload);
  const updates: Tag[] = [];

  for (const object of objects) {
    const rawTagId =
      object.tagId ??
      object.tag_id ??
      object.tagID ??
      object.id;

    const x = numberValue(
      object.x ??
        object.pos_x ??
        object.position_x ??
        object.location_x
    );

    const y = numberValue(
      object.y ??
        object.pos_y ??
        object.position_y ??
        object.location_y
    );

    const payloadFloor =
      object.floorId ??
      object.floor_id ??
      object.floor ??
      object.floorID;

    if (rawTagId === undefined || x === null || y === null) {
      continue;
    }

    if (
      typeof rawTagId !== "string" &&
      typeof rawTagId !== "number"
    ) {
      continue;
    }

    if (
      payloadFloor !== undefined &&
      !sameId(payloadFloor, floorId)
    ) {
      continue;
    }

    const resolvedFloorId =
      payloadFloor !== undefined ? payloadFloor : floorId;

    const normalizedFloorId =
      typeof resolvedFloorId === "string" ||
      typeof resolvedFloorId === "number"
        ? resolvedFloorId
        : undefined;

    const rawTimestamp =
      object.timestamp ??
      object.time ??
      object.unix_time ??
      object.unixTime ??
      object.lastSeenAt ??
      object.date_now ??
      object.created_at;

    updates.push({
      ...object,
      id: rawTagId,
      floor_id: normalizedFloorId,
      x,
      y,
      tagId: rawTagId,
      _socketEvent: eventName,
      _eventTimestamp: rawTimestamp,
    });
  }

  return updates;
}

export default function LiveMap({
  placeId,
  buildingId,
  floor,
  anchors,
  tags: initialTags,
  tagIdFilter = "",
  zones,
}: {
  placeId: number | string;
  buildingId: number | string;
  floor: Floor;
  anchors: Anchor[];
  tags: Tag[];
  tagIdFilter?: string;
  zones: Zone[];
}) {
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [showAnchors, setShowAnchors] = useState(true);
  const [socketState, setSocketState] = useState<SocketState>("loading");
  const [socketInfo, setSocketInfo] = useState("Starting real-time connection...");
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [socketTagGroups, setSocketTagGroups] = useState<TagGroup[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeTagCheckReady, setActiveTagCheckReady] = useState(false);

  useEffect(() => {
    setTags(initialTags);
    setActiveTagIds(new Set());
    setActiveTagCheckReady(false);
  }, [initialTags, floor.id]);

  // MongoDB is the source of truth for whether a tag is currently active.
  // A tag remains visible while it keeps sending activity, even when it is
  // stationary. It disappears after 10 seconds without a new position event.
  useEffect(() => {
    let cancelled = false;

    async function checkActiveTags() {
      try {
        const response = await fetch(
          `/api/active-tags?buildingId=${encodeURIComponent(String(buildingId))}&floorId=${encodeURIComponent(String(floor.id))}`,
          { cache: "no-store" }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (cancelled) return;

        const active = Array.isArray(data?.tags) ? data.tags : [];
        const ids = new Set<string>();

        setTags((current) => {
          const next = [...current];

          for (const activeTag of active) {
            const tagId = activeTag?.tagId;
            if (tagId === undefined || tagId === null) continue;
            const id = String(tagId);
            ids.add(id);

            const index = next.findIndex((tag) =>
              sameId(tag.id ?? tag.tagId ?? tag.tag_id, tagId)
            );

            const normalized: Tag = {
              ...activeTag,
              id: tagId,
              tagId,
              floor_id: activeTag.floorId ?? floor.id,
              x: numberValue(activeTag.x),
              y: numberValue(activeTag.y),
            };

            if (index >= 0) {
              next[index] = { ...next[index], ...normalized };
            } else {
              next.push(normalized);
            }
          }

          return next;
        });

        setActiveTagIds(ids);
        setActiveTagCheckReady(true);
      } catch (error) {
        console.error("[TagMonitor] Active tag check failed:", error);
      }
    }

    void checkActiveTags();
    const timer = window.setInterval(() => void checkActiveTags(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [buildingId, floor.id]);

  const visibleTags = useMemo(() => {
    if (!activeTagCheckReady) return [];

    const filter = tagIdFilter.trim();
    const activeTags = tags.filter((tag) =>
      activeTagIds.has(String(tag.id ?? tag.tagId ?? tag.tag_id))
    );

    if (!filter) return activeTags;

    return activeTags.filter((tag) => {
      const id = tag.id ?? tag.tagId ?? tag.tag_id;
      return id !== undefined && String(id) === filter;
    });
  }, [tags, activeTagIds, activeTagCheckReady, tagIdFilter]);

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
      const groupName =
        getStringField(tag, "group_name", "groupName", "group", "group_name_en") ||
        "Ungrouped";
      const members = groups.get(groupName) ?? [];
      members.push(tag);
      groups.set(groupName, members);
    }

    return Array.from(groups.entries()).map(([groupName, members]) => ({
      groupName,
      members,
    }));
  }

  useEffect(() => {
    setSocketTagGroups(buildTagGroups(visibleTags));
  }, [visibleTags]);

  function eventTime(value: unknown): string {
    if (typeof value === "number") {
      const milliseconds = value < 100000000000 ? value * 1000 : value;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }

    if (typeof value === "string" && value.trim()) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }

    return new Date().toISOString();
  }

  async function saveTagEvents(updates: Tag[], eventName: string) {
    const events = updates.map((tag) => ({
      // UNAI RTLS payload uses `id`, `building`, `floor`, `timestamp`, `x`, `y`.
      // Keep the normalized names in MongoDB, but preserve the original object.
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

    if (!events.length) return;

    console.log("[MongoDB] Sending socket tag events:", events);

    try {
      const response = await fetch("/api/tag-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(result?.error || `HTTP ${response.status}`);
      }

      console.log(`[MongoDB] Saved ${events.length} tag event(s)`);
    } catch (error) {
      console.error("[MongoDB] Failed to save tag event:", error);
    }
  }

  function addTimelineEvents(updates: Tag[], eventName: string) {
    const newEvents: TimelineEvent[] = updates.map((tag) => {
      const tagId = String(tag.id ?? tag.tagId ?? "unknown");
      const tagName = getStringField(tag, "label", "name", "tag_name", "tagName") || `Tag ${tagId}`;
      return {
        id: `${tagId}-${eventTime(tag._eventTimestamp)}-${Math.random()}`,
        tagId,
        tagName,
        event: eventName,
        x: Number(tag.x),
        y: Number(tag.y),
        timestamp: eventTime(tag._eventTimestamp),
      };
    });

    if (newEvents.length > 0) {
      setTimeline((current) => [...newEvents, ...current].slice(0, 100));
    }
  }

  useEffect(() => {
    // UNAI Socket.IO is now owned by the Node.js backend. The browser only
    // polls the backend's MongoDB-backed active-tag endpoint. This prevents
    // every Building tab/floor from creating a separate UNAI connection.
    const backendRealtimeTimer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/active-tags?buildingId=${encodeURIComponent(String(buildingId))}&floorId=${encodeURIComponent(String(floor.id))}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;

        const data = await response.json();
        const active = Array.isArray(data?.tags) ? data.tags : [];
        const ids = new Set<string>();

        setTags((current) => {
          const next = [...current];
          for (const activeTag of active) {
            if (activeTag?.tagId == null) continue;
            const id = String(activeTag.tagId);
            ids.add(id);
            const index = next.findIndex((tag) =>
              sameId(tag.id ?? tag.tagId ?? tag.tag_id, activeTag.tagId),
            );
            const normalized: Tag = {
              ...activeTag,
              id: activeTag.tagId,
              tagId: activeTag.tagId,
              floor_id: activeTag.floorId ?? floor.id,
              x: numberValue(activeTag.x),
              y: numberValue(activeTag.y),
            };
            if (index >= 0) next[index] = { ...next[index], ...normalized };
            else next.push(normalized);
          }
          return next;
        });

        setActiveTagIds(ids);
        setActiveTagCheckReady(true);
        setSocketState("connected");
        setSocketInfo("Realtime data is supplied by the backend Socket Manager.");
        if (active.length > 0) setLastUpdate(new Date().toLocaleTimeString());
      } catch (error) {
        console.error("[UNAI RTLS] Backend realtime check failed:", error);
      }
    }, 2000);

    // Run immediately instead of waiting for the first interval tick.
    void (async () => {
      try {
        const response = await fetch(
          `/api/active-tags?buildingId=${encodeURIComponent(String(buildingId))}&floorId=${encodeURIComponent(String(floor.id))}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const active = Array.isArray(data?.tags) ? data.tags : [];
        const ids = new Set<string>(active.map((tag: Tag) => String(tag.tagId ?? tag.id ?? "")));
        setTags((current) => {
          const next = [...current];
          for (const activeTag of active) {
            const index = next.findIndex((tag) => sameId(tag.id ?? tag.tagId ?? tag.tag_id, activeTag.tagId));
            const normalized: Tag = { ...activeTag, id: activeTag.tagId, tagId: activeTag.tagId, floor_id: activeTag.floorId ?? floor.id, x: numberValue(activeTag.x), y: numberValue(activeTag.y) };
            if (index >= 0) next[index] = { ...next[index], ...normalized };
            else next.push(normalized);
          }
          return next;
        });
        setActiveTagIds(ids);
        setActiveTagCheckReady(true);
        setSocketState("connected");
        setSocketInfo("Realtime data is supplied by the backend Socket Manager.");
      } catch (error) {
        console.error("[UNAI RTLS] Initial backend realtime check failed:", error);
        setSocketState("error");
        setSocketInfo("Backend realtime data is unavailable.");
      }
    })();

    return () => window.clearInterval(backendRealtimeTimer);

    /* Legacy direct-browser socket implementation kept below for reference.
       It is intentionally unreachable: UNAI connections are now managed by
       the backend Socket Manager above. */
    let socket: SocketLike | null = null;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;

    async function connect() {
      const floorID = floor.id;
      if (floorID === undefined || floorID === null) return;

      const socketKey = `${String(placeId)}:${String(buildingId)}:${String(floorID)}`;

      try {
        if (sharedSocketDisconnectTimer !== null) {
          window.clearTimeout(sharedSocketDisconnectTimer);
          sharedSocketDisconnectTimer = null;
        }

        // Reuse an already connected/connecting socket for this exact floor.
        // This prevents duplicate handshakes when React remounts the component.
        if (sharedSocket && sharedSocketKey === socketKey) {
          socket = sharedSocket;
          setSocketState(sharedSocket.connected ? "connected" : "connecting");
          setSocketInfo(
            sharedSocket.connected
              ? `Connected as ${sharedSocket.id ?? "socket"}. Reusing UNAI connection.`
              : "Reusing the existing UNAI RTLS connection..."
          );
          return;
        }

        if (sharedSocket && sharedSocketKey !== socketKey) {
          sharedSocket.disconnect();
          sharedSocket = null;
          sharedSocketKey = "";
        }

        // Never hammer the UNAI socket endpoint while it is rate-limiting us.
        // The server-side rate limit cannot be cleared by JavaScript; waiting
        // here prevents a page/floor change from extending the lockout.
        if (Date.now() < sharedSocketRateLimitedUntil) {
          const remaining = Math.ceil((sharedSocketRateLimitedUntil - Date.now()) / 1000);
          setSocketState("error");
          setSocketInfo(`UNAI temporarily rate-limited socket connections. Please wait about ${remaining}s before retrying.`);
          return;
        }

        setSocketState("loading");
        setSocketInfo(`Getting socket token for floor ${String(floorID)}...`);

        // Generate the floor socket token only once while a request is in
        // flight. Multiple component mounts must not request multiple tokens.
        if (!sharedSocketTokenPromise || sharedSocketTokenKey !== socketKey) {
          sharedSocketTokenKey = socketKey;
          sharedSocketTokenPromise = fetch("/api/socket-topic", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ floorID }),
          }).then(async (response) => {
            const credentials = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(credentials?.error || `HTTP ${response.status}`);
            }
            if (!credentials.socket_token) {
              throw new Error("Socket API did not return socket_token");
            }
            return String(credentials.socket_token);
          });
        }

        const socketToken = await sharedSocketTokenPromise;
        if (cancelled) return;

        setSocketInfo("Socket token received. Connecting to UNAI RTLS...");
        setSocketState("connecting");

        const connectWithIo = (ioFactory: any) => {
          if (cancelled) return;

          if (sharedSocket && sharedSocketKey === socketKey) {
            socket = sharedSocket;
            setSocketState(sharedSocket.connected ? "connected" : "connecting");
            return;
          }

          // UNAI RTLS Socket.IO protocol:
          // Host: https://socket.lailab.online
          // Path: /ble/location
          // Auth: ?token=<socket_token>
          socket = ioFactory("https://socket.lailab.online", {
            path: "/ble/location",
            query: { token: socketToken },
            transports: ["websocket"],
            // IMPORTANT: never let Socket.IO retry a rejected UNAI handshake.
            // Reconnect loops are what trigger "Too many connection attempts".
            reconnection: false,
            // Do not force a brand-new Manager. Reuse the Socket.IO Manager
            // where possible and also guard the socket at module level above.
            forceNew: false,
          }) as SocketLike;

          sharedSocket = socket;
          sharedSocketKey = socketKey;

          const handlePosition = (payload: unknown, eventName: string) => {
            console.log(`[UNAI RTLS] ${eventName}:`, payload);
            setMessageCount((count) => count + 1);

            const updates = findTagUpdates(payload, eventName, floorID);
            if (!updates.length) return;

            setTags((current) => {
              const next = [...current];
              for (const update of updates) {
                const tagId = update.id ?? update.tagId ?? update.tag_id;
                const index = next.findIndex((tag) =>
                  sameId(tag.id ?? tag.tagId ?? tag.tag_id, tagId)
                );
                if (index >= 0) next[index] = { ...next[index], ...update };
                else next.push(update);
              }
              return next;
            });

            console.log("[UNAI RTLS] TAG GROUPS:", buildTagGroups(updates));
            addTimelineEvents(updates, eventName);
            void saveTagEvents(updates, eventName);
            setLastUpdate(new Date().toLocaleTimeString());
          };

          const onAnchor = (payload: unknown) => {
            console.log("[UNAI RTLS] anchor:", payload);
            setMessageCount((count) => count + 1);
          };

          const onConnect = () => {
            const baseTopic = `unai/${placeId}/${buildingId}/${floorID}`;

            setSocketState("connected");
            setSocketInfo(`Connected as ${socket?.id ?? "socket"}. Joining floor rooms...`);
            console.log("[UNAI RTLS] connected", socket?.id);

            // 1. Register this browser/client.
            socket?.emit("/register", {
              customId: `client_${buildingId}_${floorID}`,
            });

            // 2. Join the required UNAI rooms for this floor.
            socket?.emit("/join", `${baseTopic}/tag`);
            socket?.emit("/join", `${baseTopic}/anchor`);
            socket?.emit("/join", `${baseTopic}/alert`);

            // 3. Request the initial location immediately.
            socket?.emit("/broadcastToRoom", {
              room: "init_unai_location",
              data: {
                action: "get_init_unai_location",
                get_topic: `${placeId}/${buildingId}/${floorID}`,
              },
            });

            console.log("[UNAI RTLS] registered and joined:", {
              tag: `${baseTopic}/tag`,
              anchor: `${baseTopic}/anchor`,
              alert: `${baseTopic}/alert`,
            });
          };

          const onDisconnect = (reason: string) => {
            setSocketState("disconnected");
            setSocketInfo(
              reason === "io server disconnect"
                ? "UNAI server disconnected this client. Refresh the page to request a fresh connection."
                : `Disconnected: ${reason}. Automatic reconnect is disabled.`
            );
          };

          const onConnectError = (error: any) => {
            const message = error?.message ?? String(error);
            console.error("[UNAI RTLS] connect_error", message);
            setSocketState("error");

            const rateLimited = /too many connection attempts|rate.?limit/i.test(message);
            if (rateLimited) {
              // Do not immediately reconnect or request another socket token.
              // UNAI's limiter is server-side, so repeated attempts only make
              // the lockout last longer.
              sharedSocketRateLimitedUntil = Date.now() + SOCKET_RATE_LIMIT_COOLDOWN_MS;
              setSocketInfo("UNAI is rate-limiting socket connections. No automatic reconnect will be attempted for 60 seconds.");
            } else {
              setSocketInfo(`Socket connection error: ${message}`);
            }

            if (sharedSocket === socket) {
              sharedSocket = null;
              sharedSocketKey = "";
            }

            // Explicitly stop the Manager after a rejected handshake so there
            // is no hidden reconnect loop.
            socket?.disconnect();
          };

          socket.on("connect", onConnect);
          socket.on("disconnect", onDisconnect);
          socket.on("connect_error", onConnectError);
          socket.on("tag", (payload: unknown) => handlePosition(payload, "tag"));
          socket.on("clientBox", (payload: unknown) => handlePosition(payload, "clientBox"));
          socket.on("sensor", (payload: unknown) => handlePosition(payload, "sensor"));
          socket.on("message", (payload: unknown) => handlePosition(payload, "message"));
          socket.on("anchor", onAnchor);
        };

        const existingIo = (window as any).io;
        if (typeof existingIo === "function") {
          connectWithIo(existingIo);
          return;
        }

        script = document.createElement("script");
        script.src = "https://cdn.socket.io/4.8.1/socket.io.min.js";
        script.async = true;
        script.onload = () => {
          const ioFactory = (window as any).io;
          if (typeof ioFactory !== "function") {
            setSocketState("error");
            setSocketInfo("Socket.IO client script loaded but window.io is unavailable.");
            return;
          }
          connectWithIo(ioFactory);
        };
        script.onerror = () => {
          setSocketState("error");
          setSocketInfo("Could not load Socket.IO client from CDN.");
        };
        document.head.appendChild(script);
      } catch (error) {
        console.error("[UNAI RTLS] setup failed", error);
        setSocketState("error");
        setSocketInfo(error instanceof Error ? error.message : String(error));
      }
    }

    // Delay the first connection slightly. Next.js/React Strict Mode can mount
    // client components twice in development; the delay lets the first effect
    // cleanup cancel before a real Socket.IO connection is opened.
    const connectTimer = window.setTimeout(() => {
      void connect();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);

      // Do not immediately disconnect here. React Strict Mode intentionally
      // runs effect cleanup followed by a second setup in development. A short
      // grace period lets the second setup reuse the same socket instead of
      // creating another UNAI handshake and triggering rate limiting.
      if (sharedSocket === socket) {
        sharedSocketDisconnectTimer = window.setTimeout(() => {
          if (sharedSocket === socket) {
            socket?.off("connect");
            socket?.off("disconnect");
            socket?.off("connect_error");
            socket?.disconnect();
            sharedSocket = null;
            sharedSocketKey = "";
          }
          sharedSocketDisconnectTimer = null;
        }, SOCKET_CLEANUP_GRACE_MS);
      } else {
        socket?.off("connect");
        socket?.off("disconnect");
        socket?.off("connect_error");
      }

      if (script?.parentNode) script.parentNode.removeChild(script);
    };
  }, [placeId, buildingId, floor.id]);

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
        <span className="ml-auto text-slate-400">Socket events: {messageCount}{lastUpdate ? ` · Last tag update ${lastUpdate}` : ""}</span>
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

          {zones.map((zone) => {
            const rawPolygon = parsePolygon(zone.polygon_data);
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
                style={{ inset: 0, clipPath: `polygon(${points})`, background: zone.zone_color ? `${zone.zone_color}30` : "rgba(139,92,246,.12)", borderColor: zone.zone_color ?? "#8b5cf6", pointerEvents: "none" }}
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
            <span
            className={`rounded-full px-2 py-0.5 font-extrabold ${
            showAnchors
            ? "bg-white text-emerald-600"
            : "bg-white text-red-600"
            }`}
            >
            {showAnchors ? "ON" : "OFF"}
            </span>
            </button>

            {showAnchors && (
              <div className="absolute inset-0">
                {anchors.map((anchor) => {
                  const realX = numberValue(anchor.x);
                  const realY = numberValue(anchor.y);
                  if (realX === null || realY === null) return null;
                  const { px, py } = toPixel(realX, realY, floor);
                  return (
                    <div
                      key={`anchor-${String(anchor.id)}`}
                      title={String(anchor.label ?? anchor.id ?? "Anchor")}
                      className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[9px] font-bold text-white shadow-lg ${
                        anchor.status === 1 ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                      style={{
                        left: `${(px / width) * 100}%`,
                        top: `${(py / height) * 100}%`,
                      }}
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
            const { px, py } = toPixel(realX, realY, floor);
            const tagName = String(tag.label ?? tag.name ?? `Tag ${tag.id ?? ""}`);
            return (
              <div key={`tag-${String(tag.id ?? tag.tagId)}`} title={`${tagName} · X: ${realX} · Y: ${realY}`} className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-[left,top] duration-150" style={{ left: `${(px / width) * 100}%`, top: `${(py / height) * 100}%` }}>
                <div className="flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-white bg-sky-600 px-2 text-[9px] font-bold text-white shadow-lg">T</div>
                <span className="mt-1 max-w-28 truncate rounded bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold text-slate-700 shadow">{tagName}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">Tag Groups</h2>
            <p className="text-xs text-slate-400">Grouped from real-time Socket.IO tag data</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {socketTagGroups.length} group{socketTagGroups.length === 1 ? "" : "s"}
          </span>
        </div>

        {socketTagGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-400">
            Waiting for tag data from Socket.IO...
          </div>
        ) : (
          <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
            {socketTagGroups.map((group) => (
              <div
                key={group.groupName}
                className="rounded-lg border border-slate-200 bg-slate-50 p-2"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="min-w-0 truncate text-xs font-bold text-slate-800">{group.groupName}</h3>
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                    {group.members.length}
                  </span>
                </div>

                <div className="mt-1 max-h-24 space-y-1 overflow-y-auto pr-1">
                  {group.members.map((tag, index) => {
                    const firstname = getStringField(tag, "firstname", "first_name", "firstName");
                    const lastname = getStringField(tag, "lastname", "last_name", "lastName");
                    const fullName = `${firstname} ${lastname}`.trim();
                    const tagName = getStringField(tag, "label", "name", "tag_name", "tagName");
                    const tagId = tag.id ?? tag.tagId ?? tag.tag_id ?? index;

                    return (
                      <div
                        key={String(tagId)}
                        className="rounded-md border border-white bg-white px-2 py-1 shadow-sm"
                      >
                        <p className="truncate text-[10px] font-semibold text-slate-700">
                          {fullName || tagName || `Tag ${String(tagId)}`}
                        </p>
                        <p className="mt-0.5 truncate text-[9px] text-slate-400">
                          {tagName && fullName ? `${tagName} · ` : ""}
                          Tag ID: {String(tagId)}
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
