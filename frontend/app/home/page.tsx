"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type ApiRecord = Record<string, unknown>;
type ApiResponse = ApiRecord[] | ApiRecord;

type Anchor = ApiRecord & { status?: number };
type Tag = ApiRecord & { status?: number; lastSeen?: string };

type TagSocketFloor = string;

type HomeSocket = {
  id?: string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => void;
  disconnect: () => void;
};

// Recursively find tag objects inside the different payload shapes sent by UNAI RTLS.
function findSocketTags(value: unknown, result: { id: string; lastSeen: string }[] = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item) => findSocketTags(item, result));
    return result;
  }

  const object = value as Record<string, unknown>;
  const rawId = object.tagId ?? object.tag_id ?? object.tagID ?? object.id;
  const hasPosition = object.x !== undefined || object.y !== undefined;

  if (rawId !== undefined && (typeof rawId === "string" || typeof rawId === "number") && hasPosition) {
    // Online status is based on when THIS browser receives the socket event,
    // not on a possibly old timestamp inside the RTLS payload.
    result.push({ id: String(rawId), lastSeen: new Date().toISOString() });
  }

  Object.values(object).forEach((child) => {
    if (child && typeof child === "object") findSocketTags(child, result);
  });

  return result;
}

async function getApi(path: string): Promise<ApiResponse> {
  // Use Next.js proxy so the browser never connects directly to localhost:4000.
  const response = await fetch(path, {
    cache: "no-store",
  });

  if (!response.ok) {
    let details = "";
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        const message = record.error ?? record.message;
        const upstream = record.details;
        details = [message, upstream ? JSON.stringify(upstream) : ""]
          .filter(Boolean)
          .join(" — ");
      }
    } catch {
      // The backend may return a non-JSON error body.
    }

    throw new Error(
      `Failed to fetch ${path}: HTTP ${response.status}${details ? ` — ${details}` : ""}`,
    );
  }

  return response.json() as Promise<ApiResponse>;
}

function getItems(data: ApiResponse): ApiRecord[] {
  if (Array.isArray(data)) return data;

  const possibleArrays = [
    data.data,
    data.items,
    data.results,
    data.places,
    data.buildings,
    data.anchors,
    data.tags,
  ];

  const firstArray = possibleArrays.find(Array.isArray);
  return firstArray ? (firstArray as ApiRecord[]) : [data];
}

function getName(item: ApiRecord, fallback: string) {
  return String(item.name ?? item.title ?? item.code ?? fallback);
}

export default function Home() {
  const [anchorData, setAnchorData] = useState<ApiResponse | null>(null);
  const [tagData, setTagData] = useState<ApiResponse | null>(null);
  const [placeData, setPlaceData] = useState<ApiResponse | null>(null);
  const [buildingData, setBuildingData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Keep the Home Socket.IO connections outside React state so status updates
  // do not recreate the socket connection.
  const homeSockets = useRef<HomeSocket[]>([]);
  // One Socket.IO connection is shared by all floors to avoid opening
  // multiple connections to the RTLS server and triggering its rate limit.
  const homeSocket = useRef<HomeSocket | null>(null);
  const socketStarted = useRef(false);
  const [socketFloorIds, setSocketFloorIds] = useState<TagSocketFloor[]>([]);
  const [panelVisibility, setPanelVisibility] = useState({
    stats: true,
    tags: true,
    places: true,
    buildings: true,
    api: true,
  });

  useEffect(() => {
    const savedPanels = localStorage.getItem("adminPanelVisibility");
    if (!savedPanels) return;

    try {
      const parsed: unknown = JSON.parse(savedPanels);
      if (parsed && typeof parsed === "object") {
        setPanelVisibility((current) => ({
          ...current,
          ...(parsed as Partial<typeof current>),
        }));
      }
    } catch {
      // Ignore invalid saved settings.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadHomeData() {
      setLoading(true);
      setError(null);

      try {
        // Authentication is handled by the backend lazily. Do not call
        // /api/auth/token from the browser: every real UNAI API request already
        // obtains/reuses the backend token, and the token must never be exposed
        // to the frontend.
        const [anchors, tags, places, buildings, floors] = await Promise.all([
          getApi("/api/anchor"),
          // /api/tag supplies the tag list/details only. Socket.IO below is
          // responsible for the live ONLINE/OFFLINE status.
          getApi("/api/tag"),
          getApi("/api/v1/get_all_place"),
          getApi("/api/v1/get_all_building"),
          // Use the floor endpoint to discover Socket.IO rooms. The tag API
          // does not reliably include a floor ID, which previously left
          // socketFloorIds empty and prevented the Home socket from starting.
          getApi("/api/floors"),
        ]);

        if (cancelled) return;

        setAnchorData(anchors);
        // The API's old status value is deliberately ignored. Tags start as
        // OFFLINE/unknown until a live Socket.IO event is received.
        const initialTagItems: Tag[] = getItems(tags).map((tag) => ({
          ...tag,
          status: 0,
        }));
        setTagData(initialTagItems);
        // Build the Socket.IO floor list from the dedicated floor API rather
        // than from tags. The tag response can omit floorId, while /api/floors
        // is specifically responsible for returning floor records.
        const floorItems = getItems(floors);
        const floorIds = Array.from(
          new Set(
            floorItems
              .map(
                (floor) =>
                  floor.id ??
                  floor.floorId ??
                  floor.floor_id ??
                  floor.floorID,
              )
              .filter(
                (id) =>
                  (typeof id === "string" || typeof id === "number") &&
                  String(id) !== "",
              )
              .map(String),
          ),
        );

        console.log("[UNAI HOME][SOCKET] Floor IDs found from /api/floors:", floorIds);
        setSocketFloorIds(floorIds);
        setPlaceData(places);
        setBuildingData(buildings);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          console.error("[UNAI HOME] API loading failed:", message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadHomeData();

    return () => {
      cancelled = true;
    };
  }, []);

  const anchors = anchorData ? (getItems(anchorData) as Anchor[]) : [];
  const tags = tagData ? (getItems(tagData) as Tag[]) : [];
  const places = placeData ? getItems(placeData) : [];
  const buildings = buildingData ? getItems(buildingData) : [];

  const aliveAnchors = anchors.filter((anchor) => anchor.status === 1).length;
  const offlineAnchors = anchors.filter((anchor) => anchor.status === 0).length;
  const aliveTags = tags.filter((tag) => tag.status === 1).length;
  const offlineTags = tags.length - aliveTags;

  // LIVE TAG STATUS FOR HOME:
  // - Keep /api/tag only for the initial tag list.
  // - Get a socket token from our backend for each floor represented by the tags.
  // - Join the same UNAI RTLS tag room used by the Building live map.
  // - Every received tag position marks that tag ONLINE and updates lastSeen.
  // - If no socket update arrives for 10 seconds, mark the tag OFFLINE.
  useEffect(() => {
    if (!socketFloorIds.length || socketStarted.current) return;

    const floorIds = socketFloorIds;
    socketStarted.current = true;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;

    const handleTagPayload = (payload: unknown) => {
      const updates = findSocketTags(payload);
      if (!updates.length) {
        console.log(
          "[UNAI HOME][SOCKET] Event received, but no tag position was found.",
        );
        return;
      }

      console.log("[UNAI HOME][SOCKET] TAG UPDATE:", updates);

      setTagData((current) => {
        if (!current) return current;
        const updateMap = new Map(updates.map((update) => [update.id, update.lastSeen]));

        return getItems(current).map((tag) => {
          const id = tag.id ?? tag.tagId ?? tag.tag_id;
          const lastSeen = id !== undefined ? updateMap.get(String(id)) : undefined;
          return lastSeen ? { ...tag, status: 1, lastSeen } : tag;
        });
      });
    };

    const startSockets = async (ioFactory: any) => {
      if (cancelled || !floorIds.length || homeSocket.current) return;

      // Request one socket token for the first floor and use one shared
      // Socket.IO connection for every floor. Multiple RTLS connections were
      // causing "Too many connection attempts" from the socket server.
      const tokenFloorId = floorIds[0];

      try {
        console.log(`[UNAI HOME][SOCKET] Requesting shared token using floor: ${tokenFloorId}`);

        const response = await fetch("/api/socket-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ floorID: tokenFloorId }),
        });
        const credentials = await response.json();

        console.log(
          `[UNAI HOME][SOCKET] Token response: HTTP ${response.status}`,
        );

        if (!response.ok || !credentials?.socket_token) {
          console.error("[UNAI HOME] Shared socket token failed:", credentials?.error);
          return;
        }

        console.log("[UNAI HOME][SOCKET] Shared token received");

        if (cancelled) return;

        console.log("[UNAI HOME][SOCKET] Creating ONE shared connection...");

        const socket = ioFactory("https://socket.lailab.online", {
          path: "/ble/location",
          query: { token: credentials.socket_token },
          transports: ["websocket"],
          reconnection: false,
          forceNew: true,
        }) as HomeSocket;

        homeSocket.current = socket;
        homeSockets.current = [socket];

        const handleTag = (payload: unknown) => {
          console.log("[UNAI HOME][SOCKET] EVENT", payload);
          handleTagPayload(payload);
        };

        socket.on("tag", handleTag);
        socket.on("clientBox", handleTag);
        socket.on("sensor", handleTag);
        socket.on("message", handleTag);

        socket.on("connect", () => {
          console.log("[UNAI HOME][SOCKET] CONNECTED", {
            socketId: socket.id,
            floors: floorIds,
          });

          // Register once, then join the tag room for every floor through the
          // same socket connection.
          socket.emit("/register", { customId: "home" });

          for (const floorId of floorIds) {
            const baseTopic = `unai/*/*/${floorId}`;
            console.log(`[UNAI HOME][SOCKET] Joining topic: ${baseTopic}/tag`);
            socket.emit("/join", `${baseTopic}/tag`);
          }
        });

        socket.on("connect_error", (socketError: unknown) => {
          console.error("[UNAI HOME][SOCKET] CONNECT ERROR:", socketError);
        });

        socket.on("disconnect", (reason: unknown) => {
          console.warn("[UNAI HOME][SOCKET] DISCONNECTED:", reason);
          homeSocket.current = null;
        });
      } catch (socketError) {
        console.error("[UNAI HOME] Shared socket setup failed:", socketError);
      }
    };

    const existingIo = (window as any).io;
    if (typeof existingIo === "function") {
      void startSockets(existingIo);
    } else {
      script = document.createElement("script");
      script.src = "https://cdn.socket.io/4.8.1/socket.io.min.js";
      script.async = true;
      script.onload = () => {
        const ioFactory = (window as any).io;
        if (typeof ioFactory === "function") void startSockets(ioFactory);
      };
      script.onerror = () => console.error("[UNAI HOME] Could not load Socket.IO client.");
      document.head.appendChild(script);
    }

    const statusTimer = window.setInterval(() => {
      const cutoff = Date.now() - 10000;
      setTagData((current) => {
        if (!current) return current;
        return getItems(current).map((tag) => {
          const lastSeen = tag.lastSeen;
          const time = typeof lastSeen === "string" ? new Date(lastSeen).getTime() : 0;
          return { ...tag, status: time > cutoff ? 1 : 0 };
        });
      });
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(statusTimer);
      homeSockets.current.forEach((socket) => socket.disconnect());
      homeSockets.current = [];
      homeSocket.current = null;
      if (script?.parentNode) script.parentNode.removeChild(script);
      socketStarted.current = false;
    };
  }, [socketFloorIds]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
        <header className="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-600">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.45)]" />
              Indoor Location Platform
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
              Building Overview
            </h1>
            <p className="mt-3 max-w-2xl text-slate-500">
              Places, buildings and positioning infrastructure connected to your backend API.
            </p>
          </div>

          <Link
            href="/"
            className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
          >
            Log out
          </Link>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-500 shadow-sm">
            Loading building data...
          </div>
        )}

        {panelVisibility.stats && (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <StatCard label="Places" value={places.length} icon="⌖" />
            <StatCard label="Buildings" value={buildings.length} icon="▥" />
            <StatCard label="Anchors online" value={aliveAnchors} icon="●" valueClass="text-emerald-600" />
            <StatCard label="Anchors offline" value={offlineAnchors} icon="!" valueClass={offlineAnchors > 0 ? "text-rose-600" : "text-slate-900"} />
            <StatCard label="Tags online" value={aliveTags} icon="●" valueClass="text-emerald-600" />
            <StatCard label="Tags offline" value={offlineTags} icon="T" valueClass={offlineTags > 0 ? "text-rose-600" : "text-slate-900"} />
          </section>
        )}

        <section className="mt-8 grid gap-6 lg:grid-cols-3">
          {panelVisibility.tags && (
            <DataListCard
              title="Tags"
              subtitle="/api/tag + Socket.IO"
              icon="T"
              iconClass="bg-sky-50 text-sky-600"
              items={tags.map((tag, index) => ({
                id: tag.id,
                name: getName(tag, `Tag ${index + 1}`),
                status: tag.status === 1 ? "ONLINE" : "OFFLINE",
              }))}
            />
          )}

          {panelVisibility.places && (
            <DataListCard
              title="Places"
              subtitle="/api/v1/get_all_place"
              icon="⌖"
              iconClass="bg-cyan-50 text-cyan-600"
              items={places.map((place, index) => ({
                id: place.id,
                name: getName(place, `Place ${index + 1}`),
              }))}
            />
          )}

          {panelVisibility.buildings && (
            <DataListCard
              title="Buildings"
              subtitle="/api/v1/get_all_building"
              icon="▥"
              iconClass="bg-violet-50 text-violet-600"
              items={buildings.map((building, index) => ({
                id: building.id,
                name: getName(building, `Building ${index + 1}`),
              }))}
              linkPrefix="/building/"
            />
          )}
        </section>

        {panelVisibility.api && (
          <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-400">API routes</p>
                <h2 className="mt-1 text-xl font-semibold text-slate-900">Connected services</h2>
              </div>
              <div className="flex flex-wrap gap-2 font-mono text-xs">
                <ApiBadge text="GET /api/v1/get_all_place" />
                <ApiBadge text="GET /api/v1/get_all_building" />
                <ApiBadge text="GET /api/anchor" />
                <ApiBadge text="GET /api/tag · initial tags" />
                <ApiBadge text="Socket.IO · live tag status" />
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  icon,
  valueClass = "text-slate-900",
}: {
  label: string;
  value: number;
  icon: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">{icon}</span>
      </div>
      <p className={`mt-4 text-3xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function DataListCard({
  title,
  subtitle,
  icon,
  iconClass,
  items,
  linkPrefix,
}: {
  title: string;
  subtitle: string;
  icon: string;
  iconClass: string;
  items: { id?: unknown; name: string; status?: string }[];
  linkPrefix?: string;
}) {
  const listId = `${title.toLowerCase()}-datalist`;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${iconClass}`}>{icon}</div>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 font-mono text-xs text-slate-400">GET {subtitle}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState text={`No ${title.toLowerCase()} returned by the API.`} />
      ) : (
        <>
          <input
            list={listId}
            placeholder={`Search ${title.toLowerCase()}...`}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100"
          />
          <datalist id={listId}>
            {items.map((item, index) => (
              <option
                key={String(item.id ?? index)}
                value={item.name}
                label={item.status ? `${item.name} · ${item.status}` : `ID: ${String(item.id ?? "—")}`}
              />
            ))}
          </datalist>

          <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
            {items.map((item, index) => {
              const content = (
                <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3 transition hover:border-slate-200 hover:bg-slate-50">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500">{icon}</div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-700">{item.name}</p>
                      <p className="text-xs text-slate-400">ID: {String(item.id ?? "—")}</p>
                    </div>
                  </div>
                  {item.status && (
                    <span className={`ml-3 shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${item.status === "ONLINE" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {item.status}
                    </span>
                  )}
                </div>
              );

              return linkPrefix && item.id != null ? (
                <Link key={String(item.id)} href={`${linkPrefix}${String(item.id)}`}>
                  {content}
                </Link>
              ) : (
                <div key={String(item.id ?? index)}>{content}</div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-400">{text}</div>;
}

function ApiBadge({ text }: { text: string }) {
  return <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500">{text}</span>;
}
