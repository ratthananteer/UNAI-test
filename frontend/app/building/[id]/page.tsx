import Link from "next/link";
import BuildingLiveMap from "../../../components/map/BuildingLiveMap";

type DataItem = Record<string, unknown>;

const BACKEND_URL = (
  process.env.BACKEND_URL || "https://unai-test.onrender.com"
).replace(/\/$/, "");

async function getApi(path: string): Promise<DataItem[]> {
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      console.error(`[Building] ${path} returned HTTP ${response.status}`);
      return [];
    }

    const json: unknown = await response.json();

    if (Array.isArray(json)) {
      return json.filter(isDataItem);
    }

    if (json && typeof json === "object") {
      const object = json as DataItem;
      for (const candidate of [object.data, object.items, object.results]) {
        if (Array.isArray(candidate)) return candidate.filter(isDataItem);
      }
    }

    return [];
  } catch (error) {
    console.error(`[Building] ${path} failed:`, error);
    return [];
  }
}

function isDataItem(value: unknown): value is DataItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function getString(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

export default async function BuildingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Fetch independent APIs in parallel. The backend requests are kept
  // server-side so the browser does not wait on five separate connections.
  const [buildingResponse, floorResponse, anchorResponse, tagResponse, zoneResponse] =
    await Promise.all([
      getApi("/api/v1/get_all_building"),
      getApi("/api/floors"),
      getApi("/api/anchor"),
      getApi("/api/tag"),
      getApi("/api/zone"),
    ]);

  const buildings = buildingResponse;
  const floors = floorResponse;
  const anchors = anchorResponse;
  const tags = tagResponse;
  const zones = zoneResponse;

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

    return true;
  });

  return (
    <main className="min-h-screen bg-gray-50 p-6 text-gray-900">
      <div className="mx-auto max-w-7xl">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
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

        <section className="mt-6 overflow-hidden rounded-xl border bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-xl font-semibold">Live Map</h2>
            <p className="text-sm text-gray-500">
              Real-time building location data
            </p>
          </div>

          <BuildingLiveMap
            placeId={getId(building?.place_id ?? building?.placeId) ?? id}
            buildingId={id}
            floors={buildingFloors}
            anchors={anchors}
            tags={tags}
            zones={zones}
          />
        </section>

        <section className="mt-6 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Floor Data</h2>
          {buildingFloors.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500">
              No floor data available.
            </p>
          ) : (
            <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
              {buildingFloors.map((floor, index) => {
                const floorId =
                  getId(floor.id ?? floor.floor_id ?? floor.floorId) ?? index;
                const floorName =
                  getString(floor.name ?? floor.floor_name ?? floor.title) ||
                  `Floor ${index + 1}`;

                return (
                  <div
                    key={String(floorId)}
                    className="min-w-32 rounded-lg border px-4 py-3"
                  >
                    <div className="font-medium">{floorName}</div>
                    <div className="text-xs text-gray-500">
                      ID: {String(floorId)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="mt-6 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">API Status</h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ApiStatus name="Buildings" available={buildings.length > 0} />
            <ApiStatus name="Floors" available={floors.length > 0} />
            <ApiStatus name="Anchors" available={anchors.length > 0} />
            <ApiStatus name="Tags" available={tags.length > 0} />
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
