// BUILDING DETAIL PAGE:
// Server-side loads building configuration and the MongoDB current-tag snapshot.
// Local development talks to the local Express backend; production uses the
// configured BACKEND_URL.

import Link from "next/link";
import { cookies } from "next/headers";
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
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function unwrapItems(json: unknown): DataItem[] {
  if (Array.isArray(json)) return json.filter(isDataItem);
  if (json && typeof json === "object") {
    const object = json as DataItem;
    for (const candidate of [object.data, object.items, object.results, object.tags, object.floors, object.buildings, object.anchors, object.zones]) {
      if (Array.isArray(candidate)) return candidate.filter(isDataItem);
    }
  }
  return [];
}

async function getApi(
  path: string,
  fallbackPaths: string[] = [],
  authCookie = "",
  fallbackOnError = false,
): Promise<DataItem[]> {
  const paths = [path, ...fallbackPaths];

  for (let index = 0; index < paths.length; index += 1) {
    const currentPath = paths[index];
    const url = `${BACKEND_URL}${currentPath}`;
    const startedAt = Date.now();

    console.log("[BUILDING][RENDER][API] request", {
      path: currentPath,
      url,
      backend: BACKEND_URL,
      environment: process.env.NODE_ENV,
    });

    try {
      const requestHeaders: HeadersInit = {};
      if (authCookie) requestHeaders.cookie = authCookie;

      const response = await fetch(url, {
        cache: "no-store",
        headers: requestHeaders,
      });
      const elapsedMs = Date.now() - startedAt;

      console.log("[BUILDING][RENDER][API] response", {
        path: currentPath,
        status: response.status,
        ok: response.ok,
        elapsedMs,
      });

      if (response.ok) {
        const json = await response.json();
        const items = unwrapItems(json);
        console.log("[BUILDING][RENDER][API] parsed", {
          path: currentPath,
          itemCount: items.length,
        });
        return items;
      }

      if ((response.status === 404 || fallbackOnError) && index < paths.length - 1) {
        console.warn(`[Building] ${currentPath} returned HTTP ${response.status}; trying ${paths[index + 1]}`);
        continue;
      }

      console.error("[BUILDING][RENDER][API] failed", {
        path: currentPath,
        status: response.status,
      });
      return [];
    } catch (error) {
      console.error("[BUILDING][RENDER][API] exception", {
        path: currentPath,
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      if (index < paths.length - 1) {
        console.warn(`[Building] ${currentPath} failed; trying ${paths[index + 1]}`);
        continue;
      }
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
  const renderStartedAt = Date.now();

  const cookieStore = await cookies();
  const authCookie = cookieStore.toString();
  const hasAuthCookie = cookieStore.has("unai_auth");

  console.log("[BUILDING][RENDER] ===== BUILDING PAGE START =====", {
    id,
    backendUrl: BACKEND_URL,
    nodeEnv: process.env.NODE_ENV,
    hasAuthCookie,
    timestamp: new Date().toISOString(),
  });

  const [buildingResponse, floorResponse, anchorResponse, lastLocationResponse, tagMetadataResponse, zoneResponse] =
    await Promise.all([
      getApi("/api/v1/get_all_building", [], authCookie),
      getApi(`/api/floors?buildingId=${encodeURIComponent(id)}`, [`/api/v1/get_all_floor?buildingId=${encodeURIComponent(id)}`], authCookie),
      getApi(`/api/anchor?buildingId=${encodeURIComponent(id)}`, [], authCookie),
      // New API is the preferred current-position source for Building. The
      // fallback preserves the existing MongoDB read model if UNAI is
      // temporarily unavailable, so the main Building flow does not break.
      getApi(
        "/api/v1/get_all_tag_last_location",
        [`/api/db-tags?buildingId=${encodeURIComponent(id)}`],
        authCookie,
        true,
      ),
      getApi("/api/tag", [], authCookie),
      getApi(`/api/zone?buildingId=${encodeURIComponent(id)}`, [], authCookie),
    ]);

  const buildings = buildingResponse;
  const floors = floorResponse;
  const anchors = anchorResponse;
  const zones = zoneResponse;

  // /get_all_tag_last_location already contains the rich tag metadata used by
  // Building (name, group, zone, battery, lat/lon and lastSeenAt). Keep /tag as
  // a compatibility source only: it fills fields when an older backend record
  // is missing something, without changing the existing tag model.
  const tagById = new Map<string, DataItem>();
  for (const tag of lastLocationResponse) {
    const tagId = getId(tag.id ?? tag.tagId ?? tag.tag_id);
    if (tagId !== undefined) tagById.set(String(tagId), tag);
  }
  for (const tag of tagMetadataResponse) {
    const tagId = getId(tag.id ?? tag.tagId ?? tag.tag_id);
    if (tagId === undefined) continue;
    const previous = tagById.get(String(tagId));
    if (!previous) {
      tagById.set(String(tagId), tag);
      continue;
    }
    // New last-location data wins. Metadata only fills fields that are absent
    // from the new response, preventing stale metadata from overwriting the
    // current x/y/lastSeenAt/group/zone values.
    const merged: DataItem = { ...tag };
    for (const [key, value] of Object.entries(previous)) {
      if (value !== null && value !== undefined && value !== "") merged[key] = value;
    }
    tagById.set(String(tagId), merged);
  }
  // Keep the old MongoDB snapshot as a second compatibility fallback only
  // when the new endpoint returns no records. This branch is intentionally not
  // fetched separately; getApi above already falls back to /db-tags on 404 or
  // transport failure.
  const building = buildings.find((item) => {
    const itemId = getId(item.id ?? item.building_id ?? item.buildingId);
    return itemId !== undefined && String(itemId) === id;
  });

  const tags = Array.from(tagById.values()).filter((tag) => {
    const tagBuildingId = getId(tag.buildingId ?? tag.building_id ?? tag.building);
    return tagBuildingId === undefined || String(tagBuildingId) === id;
  });

  const buildingName = building
    ? getString(building.name ?? building.building_name ?? building.title) || `Building ${id}`
    : `Building ${id}`;

  const buildingFloors = floors.filter((floor) => {
    const floorBuildingId = getId(floor.building_id ?? floor.buildingId);
    if (floorBuildingId !== undefined) return String(floorBuildingId) === id;
    const buildingObject = floor.building;
    if (isDataItem(buildingObject)) {
      const nestedId = getId(buildingObject.id ?? buildingObject.building_id ?? buildingObject.buildingId);
      if (nestedId !== undefined) return String(nestedId) === id;
    }
    return true;
  });

  console.log("[BUILDING][RENDER] ===== BUILDING PAGE DATA READY =====", {
    id,
    buildingFound: Boolean(building),
    buildingName,
    buildings: buildings.length,
    floors: buildingFloors.length,
    allFloors: floors.length,
    anchors: anchors.length,
    tags: tags.length,
    lastLocations: lastLocationResponse.length,
    tagMetadata: tagMetadataResponse.length,
    zones: zones.length,
    elapsedMs: Date.now() - renderStartedAt,
  });

  return (
    <main className="min-h-screen bg-gray-50 p-6 text-gray-900">
      <div className="mx-auto max-w-7xl">
        <Link href="/home" className="text-sm text-blue-600 hover:underline">← Back to Home</Link>
        <div className="mt-4">
          <h1 className="text-3xl font-bold">{buildingName}</h1>
          <p className="mt-1 text-sm text-gray-500">Building ID: {id}</p>
        </div>

        <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Floors" value={buildingFloors.length} />
          <Stat label="Anchors" value={anchors.length} />
          <Stat label="Tags" value={tags.length} />
          <Stat label="Zones" value={zones.length} />
          <Stat label="Building" value={building ? "Available" : "Unavailable"} />
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
  return <div className="rounded-xl border bg-white p-4 shadow-sm"><div className="text-sm text-gray-500">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div></div>;
}

function ApiStatus({ name, available }: { name: string; available: boolean }) {
  return <div className="flex items-center justify-between rounded-lg border px-4 py-3"><span>{name}</span><span className="text-sm font-medium">{available ? "Available" : "Unavailable"}</span></div>;
}
