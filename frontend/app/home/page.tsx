"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ApiRecord = Record<string, unknown>;
type ApiResponse = ApiRecord[] | ApiRecord;

type Anchor = ApiRecord & { status?: number };
type Tag = ApiRecord & { status?: number };

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
        const [anchors, tags, places, buildings] = await Promise.all([
          getApi("/api/anchor"),
          getApi("/api/tag"),
          getApi("/api/v1/get_all_place"),
          getApi("/api/v1/get_all_building"),
        ]);

        if (cancelled) return;

        setAnchorData(anchors);
        setTagData(tags);
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
              subtitle="/api/tag"
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
                <ApiBadge text="GET /api/tag" />
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
