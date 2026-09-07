// BUILDING DETAIL PAGE:
// Server-side loads building configuration and the MongoDB current-tag snapshot.
// Local development talks to the local Express backend; production uses the
// configured BACKEND_URL. This avoids accidentally calling an old Render
// deployment during `next dev` and receiving stale/missing routes such as 404 /api/floors.

import Link from "next/link";
import { BuildingMapModes } from "../../../components/map/BuildingLiveMap";

type DataItem = Record<string, unknown>;

const BACKEND_URL = (
  process.env.BACKEND_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:4000"
    : "https://unai-backend.onrender.com")
).replace(/\/$/, "");

function isDataItem(value: unknown): value is DataItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function getString(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

function unwrapItems(json: unknown): DataItem[] {
  if (Array.isArray(json)) return json.filter(isDataItem);

  if (json && typeof json === "object") {
    const object = json as DataItem;
    for (const candidate of [
      object.data,
      object.items,
      object.results,
      object.tags,
      object.floors,
      object.buildings,
      object.anchors,
      object.zones,
    ]) {
      if (Array.isArray(candidate)) return candidate.filter(isDataItem);
    }
  }

  return [];
}

async function getApi(path: string, fallbackPaths: string[] = []): Promise<DataItem[]> {
  const paths = [path, ...fallbackPaths];

  for (let index = 0; index < paths.length; index += 1) {
    const currentPath = paths[index];

    try {
      const response = await fetch(`${BACKEND_URL}${currentPath}`, {
        cache: "no-store",
      });

      if (response.ok) {
        return unwrapItems(await response.json());
      }

      // A 404 here is normally caused by an older backend/frontend process.
      // Try the compatibility route before giving up, but do not hide other
      // HTTP errors behind a misleading fallback.
      if (response.status === 404 && index < paths.length - 1) {
        console.warn(
          `[Building] ${currentPath} returned HTTP 404; trying ${paths[index + 1]}`,
        );
        continue;
      }

      console.error(`[Building] ${currentPath} returned HTTP ${response.status}`);
      return [];
    } catch (error) {
      if (index < paths.length - 1) {
        console.warn(
          `[Building] ${currentPath} failed; trying ${paths[index + 1]}`,
          error,
        );
        continue;
      }

      console.error(`[Building] ${currentPath} failed:`, error);
      return [];
    }
  }

  return [];
}

export default async function BuildingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Load both the MongoDB latest snapshot and the UNAI tag metadata. MongoDB
  // is preferred because it contains the latest coordinates, but metadata is
  // a deliberate fallback so a newly opened Building page can still render
  // tags before TagLatest has received its first realtime packet.
  const [buildingResponse, floorResponse, anchorResponse, dbTagResponse, tagMetadataResponse, zoneResponse] =
    await Promise.all([
      getApi("/api/v1/get_all_building"),
      getApi(
        `/api/floors?buildingId=${encodeURIComponent(id)}`,
        [`/api/v1/get_all_floor?buildingId=${encodeURIComponent(id)}`],
      ),
      getApi(`/api/anchor?buildingId=${encodeURIComponent(id)}`),
      getApi(`/api/db-tags?buildingId=${encodeURIComponent(id)}`),
      getApi("/api/tag"),
      getApi(`/api/zone?buildingId=${encodeURIComponent(id)}`),
    ]);

  const buildings = buildingResponse;
  const floors = floorResponse;
  const anchors = anchorResponse;
  const zones = zoneResponse;

  // Merge by tag ID. MongoDB wins for live coordinates/status; /api/tag fills
  // missing metadata and acts as the cold-start source. This prevents the
  // Building map from becoming completely empty when TagLatest is still cold.
  const tagById = new Map<string, DataItem>();
  for (const tag of tagMetadataResponse) {
    const tagId = getId(tag.id ?? tag.tagId ?? tag.tag_id);
    if (tagId !== undefined) tagById.set(String(tagId), tag);
  }
  for (const tag of dbTagResponse) {
    const tagId = getId(tag.id ?? tag.tagId ?? tag.tag_id);
    if (tagId === undefined) continue;
    const previous = tagById.get(String(tagId));
    tagById.set(String(tagId), previous ? { ...previous, ...tag } : tag);
  }
  const tags = Array.from(tagById.values()).filter((tag) => {
    const tagBuildingId = getId(tag.buildingId ?? tag.building_id ?? tag.building);
    return tagBuildingId === undefined || String(tagBuildingId) === id;
  });

  const building = buildings.find((item) => {
    const itemId = getId(item.id ?? item.building_id ?? item.buildingId);
    return itemId !== undefined && String(itemId) === id;
  });

  const buildingName = building
    ? getString(building.name ?? building.building_name ?? building.title) ||
      `Building ${id}`
    : `Building ${id}`;

  const buildingFloors = floors.filter((floor) => {
    const floorBuildingId = getId(floor.building_id ?? floor.buildingId);
    if (floorBuildingId !== undefined) return String(floorBuildingId) === id;

    const buildingObject = floor.building;
    if (isDataItem(buildingObject)) {
      const nestedId = getId(
        buildingObject.id ??
          buildingObject.building_id ??
          buildingObject.buildingId,
      );
      if (nestedId !== undefined) return String(nestedId) === id;
    }

    // Some cached UNAI floor records do not contain a building reference.
    return true;
  });

  return (
    <main className="min-h-screen bg-gray-50 p-6 text-gray-900">
      <div className="mx-auto max-w-7xl">
        <Link href="/home" className="text-sm text-blue-600 hover:underline">
          ← Back to Home
        </Link>

        <div className="mt-4">
          <h1 className="text-3xl font-bold">{buildingName}</h1>
          <p className="mt-1 text-sm text-gray-500">Building ID: {id}</p>
        </div>

        <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Floors" value={buildingFloors.length} />
          <Stat label="Anchors" value={anchors.length} />
          <Stat label="Tags" value={tags.length} />
          <Stat label="Zones" value={zones.length} />
          <Stat
            label="Building"
            value={building ? "Available" : "Unavailable"}
          />
        </section>

        <BuildingMapModes
          placeId={getId(building?.place_id ?? building?.placeId) ?? id}
          buildingId={id}
          floors={buildingFloors}
          anchors={anchors}
          tags={tags}
          zones={zones}
        />

        <section className="mt-6 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">API Status</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ApiStatus name="Buildings" available={buildings.length > 0} />
            <ApiStatus name="Floors" available={floors.length > 0} />
            <ApiStatus name="Anchors" available={anchors.length > 0} />
            <ApiStatus name="Tags (MongoDB)" available={tags.length > 0} />
            <ApiStatus name="Zones" available={zones.length > 0} />
          </div>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ApiStatus({ name, available }: { name: string; available: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-4 py-3">
      <span>{name}</span>
      <span className="text-sm font-medium">
        {available ? "Available" : "Unavailable"}
      </span>
    </div>
  );
}
