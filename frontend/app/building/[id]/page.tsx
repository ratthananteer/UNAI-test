import Link from "next/link";
import LiveMap from "../../../components/map/LiveMap";

type ApiRecord = Record<string, unknown>;
type ApiResponse = ApiRecord[] | ApiRecord;

type Floor = ApiRecord & {
  id?: number | string;
  name?: string;
  building_id?: number | string;
  map_path?: string | null;
  map_width?: number | null;
  map_height?: number | null;
  pixel_meter?: number | null;
  origin_x?: number | null;
  origin_y?: number | null;
};

type Anchor = ApiRecord & {
  id?: number | string;
  floor_id?: number | string;
  x?: number | string | null;
  y?: number | string | null;
  label?: string;
  status?: number;
};

type Tag = ApiRecord & {
  id?: number | string;
  floor_id?: number | string;
  x?: number | string | null;
  y?: number | string | null;
  label?: string;
  name?: string;
  status?: number;
  anchor_id?: number | string | null;
};

type Zone = ApiRecord & {
  id?: number | string;
  floor_id?: number | string;
  name?: string;
  polygon_data?: string | null;
  zone_color?: string | null;
};

async function getApi(path: string): Promise<ApiResponse> {
  const response = await fetch(`http://localhost:4000${path}`, {
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Failed to fetch ${path}`);
  return response.json();
}

function getItems(data: ApiResponse): ApiRecord[] {
  if (Array.isArray(data)) return data;

  const arrays = [
    data.data,
    data.items,
    data.results,
    data.floors,
    data.buildings,
    data.anchors,
    data.zones,
  ];
  const first = arrays.find(Array.isArray);
  return first ? (first as ApiRecord[]) : [data];
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

function toPixel(
  realX: number,
  realY: number,
  floor: Floor
): { px: number; py: number } {
  const scale = numberValue(floor.pixel_meter) ?? 1;
  const originX = numberValue(floor.origin_x) ?? 0;
  const originY = numberValue(floor.origin_y) ?? 0;

  const px = originX + realX * scale;
  const py = originY - realY * scale;

  return { px, py };
}

function polygonToPixelPoints(
  polygon: [number, number][],
  floor: Floor
): [number, number][] {
  return polygon.map(([x, y]) => {
    const { px, py } = toPixel(x, y, floor);
    return [px, py];
  });
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

function numberValue(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function idValue(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

export default async function BuildingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ floor?: string }>;
}) {
  const { id } = await params;
  const { floor: floorQuery } = await searchParams;

  const [buildingData, floorData, anchorData, tagData, zoneData] = await Promise.all([
    getApi("/api/v1/get_all_building"),
    getApi("/api/floors"),
    getApi("/api/anchor"),
    getApi("/api/tag"),
    getApi("/api/zone"),
  ]);

  const buildings = getItems(buildingData);
  const floors = getItems(floorData) as Floor[];
  const anchors = getItems(anchorData) as Anchor[];
  const tags = getItems(tagData) as Tag[];
  const zones = getItems(zoneData) as Zone[];

  const building = buildings.find((item) => sameId(item.id, id));
  if (!building) {
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <div className="mx-auto max-w-4xl rounded-3xl border border-rose-200 bg-white p-8">
          <h1 className="text-2xl font-bold">Building not found</h1>
          <Link href="/home" className="mt-4 inline-block text-violet-600">
            ← Back to buildings
          </Link>
        </div>
      </main>
    );
  }

  const buildingFloors = floors
    .filter((floor) => sameId(floor.building_id, id))
    .sort((a, b) => Number(a.id) - Number(b.id));

  const selectedFloor =
    buildingFloors.find((floor) => sameId(floor.id, floorQuery)) ??
    buildingFloors[0];
  const selectedAnchors = selectedFloor
    ? anchors.filter((anchor) => sameId(anchor.floor_id, selectedFloor.id))
    : [];
  const selectedTags = selectedFloor
    ? tags.filter((tag) => sameId(tag.floor_id, selectedFloor.id))
    : [];
  const selectedZones = selectedFloor
    ? zones.filter((zone) => sameId(zone.floor_id, selectedFloor.id))
    : [];

  const placeId = idValue(
    building.place_id ?? building.placeId ?? building.placeID
  );
  const buildingId = idValue(building.id);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <Link
              href="/home"
              className="text-sm font-medium text-violet-600 hover:text-violet-700"
            >
              ← Back to buildings
            </Link>
            <h1 className="mt-2 text-3xl font-bold">
              {String(building.name ?? `Building ${id}`)}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Building ID: {String(building.id)} · {buildingFloors.length} floor(s)
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Select floor</h2>
            <p className="mt-1 text-xs text-slate-400">
              Choose a floor to view its map data.
            </p>

            <div className="mt-5 space-y-2">
              {buildingFloors.map((floor, index) => {
                const isSelected = sameId(floor.id, selectedFloor?.id);
                return (
                  <Link
                    key={String(floor.id)}
                    href={`/building/${id}?floor=${String(floor.id)}`}
                    className={`block rounded-xl border px-4 py-3 transition ${
                      isSelected
                        ? "border-violet-300 bg-violet-50 text-violet-700"
                        : "border-slate-200 hover:border-violet-200 hover:bg-violet-50/50"
                    }`}
                  >
                    <span className="font-semibold">Floor {index + 1}</span>
                    <span className="mt-1 block text-xs opacity-70">
                      {String(floor.name ?? `Floor ${index + 1}`)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </aside>

          <section className="min-w-0">
            {!selectedFloor ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-400">
                No floors were found for this building.
              </div>
            ) : (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-4">
                  <InfoCard label="Floor" value={String(selectedFloor.name ?? "—")} />
                  <InfoCard label="Anchors" value={selectedAnchors.length} />
                  <InfoCard label="Tags" value={selectedTags.length} />
                  <InfoCard label="Zones" value={selectedZones.length} />
                </div>

                <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-200 p-5">
                    <h2 className="text-xl font-semibold">Floor map</h2>
                    <p className="mt-1 text-xs text-slate-400">
                      {String(selectedFloor.name ?? "Selected floor")}
                    </p>
                  </div>

                  {buildingId === undefined ? (
                    <div className="border-t border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      Building ID is missing.
                    </div>
                  ) : placeId === undefined ? (
                    <div className="border-t border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      This building does not contain a <code>place_id</code>. The UNAI real-time
                      Socket.IO topic requires <code>placeId</code>, <code>buildingId</code>, and <code>floorId</code>.
                    </div>
                  ) : (
                    <LiveMap
                      placeId={placeId}
                      buildingId={buildingId}
                      floor={selectedFloor}
                      anchors={selectedAnchors}
                      tags={selectedTags}
                      zones={selectedZones}
                    />
                  )}
                </div>

                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <DataList
                    title="Anchors"
                    items={selectedAnchors.map((anchor) => ({
                      name: String(anchor.label ?? `Anchor ${anchor.id ?? "—"}`),
                      detail: `X: ${String(anchor.x ?? "—")} · Y: ${String(anchor.y ?? "—")} · Status: ${anchor.status === 1 ? "Online" : "Offline"}`,
                    }))}
                  />
                  <DataList
                    title="Zones"
                    items={selectedZones.map((zone) => ({
                      name: String(zone.name ?? `Zone ${zone.id ?? "—"}`),
                      detail: `ID: ${String(zone.id ?? "—")}`,
                    }))}
                  />
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className="mt-1 truncate text-lg font-bold text-slate-800">{value}</p>
    </div>
  );
}

function DataList({
  title,
  items,
}: {
  title: string;
  items: { name: string; detail: string }[];
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 max-h-80 space-y-2 overflow-auto">
        {items.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-400">No data</p>
        ) : (
          items.map((item, index) => (
            <div
              key={`${item.name}-${index}`}
              className="rounded-xl border border-slate-100 bg-slate-50 p-3"
            >
              <p className="font-semibold text-slate-700">{item.name}</p>
              <p className="mt-1 text-xs text-slate-400">{item.detail}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
