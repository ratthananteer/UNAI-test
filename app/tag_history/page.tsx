"use client";

import { useEffect, useMemo, useState } from "react";

const API = "http://localhost:4000";

type HistoryEvent = {
  _id: string;
  tagId: string;
  tagName?: string | null;
  buildingId?: string | null;
  floorId?: string | null;
  groupName?: string | null;
  event: string;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  timestamp: string;
};

export default function TagHistoryPage() {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [tagId, setTagId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadHistory() {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      if (tagId.trim()) params.set("tagId", tagId.trim());
      if (buildingId.trim()) params.set("buildingId", buildingId.trim());
      if (floorId.trim()) params.set("floorId", floorId.trim());
      params.set("limit", "500");

      const response = await fetch(`${API}/api/tag-events?${params}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      setEvents(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  const tags = useMemo(() => {
    return Array.from(
      new Map(events.map((event) => [event.tagId, event])).values(),
    );
  }, [events]);

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Tag History</h1>
            <p className="text-sm text-slate-500">
              History of tag position and activity received from UNAI RTLS.
            </p>
          </div>
          <button
            onClick={() => void loadHistory()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Refresh
          </button>
        </div>

        <div className="mb-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-4">
          <input
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            placeholder="Tag ID"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <input
            value={buildingId}
            onChange={(e) => setBuildingId(e.target.value)}
            placeholder="Building ID"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <input
            value={floorId}
            onChange={(e) => setFloorId(e.target.value)}
            placeholder="Floor ID"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <button
            onClick={() => void loadHistory()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Search
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mb-4 text-sm text-slate-500">
          {loading ? "Loading..." : `${events.length} history event(s)`}
        </div>

        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b bg-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Tag</th>
                <th className="px-4 py-3">Building</th>
                <th className="px-4 py-3">Floor</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">X</th>
                <th className="px-4 py-3">Y</th>
                <th className="px-4 py-3">Z</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event._id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3">
                    {new Date(event.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {event.tagName || event.tagId}
                    <div className="text-xs text-slate-400">ID: {event.tagId}</div>
                  </td>
                  <td className="px-4 py-3">{event.buildingId ?? "-"}</td>
                  <td className="px-4 py-3">{event.floorId ?? "-"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium">
                      {event.event}
                    </span>
                  </td>
                  <td className="px-4 py-3">{event.x ?? "-"}</td>
                  <td className="px-4 py-3">{event.y ?? "-"}</td>
                  <td className="px-4 py-3">{event.z ?? "-"}</td>
                </tr>
              ))}
              {!loading && events.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    No tag history found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 text-xs text-slate-400">
          {tags.length} unique tag(s) in the loaded history.
        </div>
      </div>
    </main>
  );
}
