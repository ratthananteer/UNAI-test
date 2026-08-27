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
  x?: number | string | null;
  y?: number | string | null;
  label?: string;
  name?: string;
  status?: number;
  group_name?: string;
  firstname?: string;
  lastname?: string;
};

type TagGroup = {
  groupName: string;
  members: Tag[];
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

    updates.push({
      ...object,
      id: rawTagId,
      floor_id: normalizedFloorId,
      x,
      y,
      tagId: rawTagId,
      _socketEvent: eventName,
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
  zones,
}: {
  placeId: number | string;
  buildingId: number | string;
  floor: Floor;
  anchors: Anchor[];
  tags: Tag[];
  zones: Zone[];
}) {
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [showAnchors, setShowAnchors] = useState(true);
  const [socketState, setSocketState] = useState<SocketState>("loading");
  const [socketInfo, setSocketInfo] = useState("Starting real-time connection...");
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [socketTagGroups, setSocketTagGroups] = useState<TagGroup[]>([]);

  useEffect(() => {
    setTags(initialTags);
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
    setSocketTagGroups(buildTagGroups(tags));
  }, [tags]);

  useEffect(() => {
    let socket: SocketLike | null = null;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;

    async function connect() {
      const floorID = floor.id;
      if (floorID === undefined || floorID === null) return;

      try {
        setSocketState("loading");
        setSocketInfo(`Getting socket token for floor ${String(floorID)}...`);

        const response = await fetch("http://localhost:4000/api/socket-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ floorID }),
        });
        const credentials = await response.json();
        if (!response.ok) throw new Error(credentials?.error || `HTTP ${response.status}`);
        if (!credentials.socket_token) {
          throw new Error("Socket API did not return socket_token");
        }

        if (cancelled) return;
        setSocketInfo("Socket token received. Connecting to UNAI RTLS...");
        setSocketState("connecting");

        const connectWithIo = (ioFactory: any) => {
          if (cancelled) return;

          // UNAI RTLS Socket.IO protocol:
          // Host: https://socket.lailab.online
          // Path: /ble/location
          // Auth: ?token=<socket_token>
          socket = ioFactory("https://socket.lailab.online", {
            path: "/ble/location",
            query: { token: credentials.socket_token },
            transports: ["websocket"],
            // Do not automatically retry a rejected connection. The UNAI
            // server rate-limits repeated attempts with "Too many connection
            // attempts". A page reload/fresh token can start a new attempt.
            reconnection: false,
            forceNew: true,
          }) as SocketLike;

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
            setSocketInfo(
              message.includes("Too many connection attempts")
                ? "UNAI is rate-limiting connection attempts. Automatic reconnect is disabled; refresh after the rate limit clears."
                : `Socket connection error: ${message}`
            );

            // Explicitly stop the manager after a rejected handshake so there
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
      socket?.off("connect");
      socket?.off("disconnect");
      socket?.off("connect_error");
      socket?.disconnect();
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

          {tags.map((tag) => {
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

      <div className="border-t border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Tag Groups</h2>
            <p className="text-xs text-slate-400">Grouped from real-time Socket.IO tag data</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            {socketTagGroups.length} group{socketTagGroups.length === 1 ? "" : "s"}
          </span>
        </div>

        {socketTagGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-400">
            Waiting for tag data from Socket.IO...
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {socketTagGroups.map((group) => (
              <div
                key={group.groupName}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800">{group.groupName}</h3>
                  <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-bold text-violet-700">
                    {group.members.length}
                  </span>
                </div>

                <div className="space-y-2">
                  {group.members.map((tag, index) => {
                    const firstname = getStringField(tag, "firstname", "first_name", "firstName");
                    const lastname = getStringField(tag, "lastname", "last_name", "lastName");
                    const fullName = `${firstname} ${lastname}`.trim();
                    const tagName = getStringField(tag, "label", "name", "tag_name", "tagName");
                    const tagId = tag.id ?? tag.tagId ?? tag.tag_id ?? index;

                    return (
                      <div
                        key={String(tagId)}
                        className="rounded-xl border border-white bg-white p-3 shadow-sm"
                      >
                        <p className="font-semibold text-slate-700">
                          {fullName || tagName || `Tag ${String(tagId)}`}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
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
