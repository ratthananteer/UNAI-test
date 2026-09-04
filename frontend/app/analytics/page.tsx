"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Summary = {
  totalTags: number;
  onlineTags: number;
  offlineTags: number;
  movingTags: number;
  totalEvents: number;
  buildingCount: number;
  floorCount: number;
};

type Activity = { timestamp: string; events: number; activeTags: number };
type Distribution = { id: string | null; name: string; count: number; online: number };
type MovingTag = { tagId: string; tagName?: string | null; events: number; lastSeen: string };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error || body?.details || "";
    } catch {}
    throw new Error(`${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  return response.json() as Promise<T>;
}

export default function AnalyticsPage() {
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [byBuilding, setByBuilding] = useState<Distribution[]>([]);
  const [byFloor, setByFloor] = useState<Distribution[]>([]);
  const [byGroup, setByGroup] = useState<Distribution[]>([]);
  const [topMoving, setTopMoving] = useState<MovingTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const query = `?hours=${hours}`;
      const [summaryData, activityData, distributionData, movingData] = await Promise.all([
        getJson<{ summary: Summary }>(`/api/analytics/summary${query}`),
        getJson<{ items: Activity[] }>(`/api/analytics/activity${query}&buckets=${hours <= 24 ? 24 : hours <= 168 ? 48 : 60}`),
        getJson<{ byBuilding: Distribution[]; byFloor: Distribution[]; byGroup: Distribution[] }>(`/api/analytics/distribution${query}`),
        getJson<{ items: MovingTag[] }>(`/api/analytics/top-moving${query}&limit=10`),
      ]);

      setSummary(summaryData.summary);
      setActivity(activityData.items || []);
      setByBuilding(distributionData.byBuilding || []);
      setByFloor(distributionData.byFloor || []);
      setByGroup(distributionData.byGroup || []);
      setTopMoving(movingData.items || []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const maxEvents = useMemo(() => Math.max(1, ...activity.map((item) => item.events)), [activity]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <Link href="/home" className="text-sm font-semibold text-cyan-600 hover:text-cyan-700">← Back to Home</Link>
            <h1 className="mt-3 text-4xl font-bold tracking-tight">Analytics Dashboard</h1>
            <p className="mt-2 text-sm text-slate-500">MongoDB-powered RTLS activity and current tag health.</p>
          </div>
          <div className="flex items-center gap-3">
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold shadow-sm outline-none">
              <option value={24}>Last 24 hours</option>
              <option value={168}>Last 7 days</option>
              <option value={720}>Last 30 days</option>
            </select>
            <button onClick={() => void load()} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">Refresh</button>
          </div>
        </header>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">{error}</div>}
        {loading && !summary && <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-500">Loading analytics...</div>}

        <section className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Total Tags" value={summary?.totalTags ?? 0} />
          <Metric label="Online" value={summary?.onlineTags ?? 0} accent="emerald" />
          <Metric label="Offline" value={summary?.offlineTags ?? 0} accent="rose" />
          <Metric label="Moving Now" value={summary?.movingTags ?? 0} accent="cyan" />
          <Metric label="Events in Range" value={summary?.totalEvents ?? 0} />
          <Metric label="Buildings" value={summary?.buildingCount ?? 0} />
          <Metric label="Floors" value={summary?.floorCount ?? 0} />
          <Metric label="Data Source" value="MongoDB" textValue />
        </section>

        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 className="text-xl font-semibold">Movement Activity</h2><p className="text-sm text-slate-400">Tag events grouped across the selected period.</p></div>
            {lastUpdated && <span className="text-xs text-slate-400">Updated {lastUpdated.toLocaleTimeString()}</span>}
          </div>
          <div className="mt-7 flex h-64 items-end gap-1 overflow-x-auto border-b border-slate-100 pb-1">
            {activity.length === 0 ? <div className="flex w-full items-center justify-center text-sm text-slate-400">No events in this period.</div> : activity.map((item) => {
              const height = Math.max(3, Math.round((item.events / maxEvents) * 220));
              return <div key={item.timestamp} title={`${new Date(item.timestamp).toLocaleString()} — ${item.events} events`} className="group flex min-w-[10px] flex-1 items-end justify-center">
                <div className="w-full max-w-7 rounded-t-md bg-cyan-500/75 transition group-hover:bg-cyan-500" style={{ height }} />
              </div>;
            })}
          </div>
          <div className="mt-3 flex justify-between text-[11px] text-slate-400">
            <span>{activity[0] ? new Date(activity[0].timestamp).toLocaleString() : ""}</span>
            <span>{activity.at(-1) ? new Date(activity.at(-1)!.timestamp).toLocaleString() : ""}</span>
          </div>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-3">
          <DistributionCard title="Tags by Building" items={byBuilding} />
          <DistributionCard title="Tags by Floor" items={byFloor} />
          <DistributionCard title="Tags by Group" items={byGroup} />
        </section>

        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div><h2 className="text-xl font-semibold">Top Moving Tags</h2><p className="mt-1 text-sm text-slate-400">Most position updates in the selected period.</p></div>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead><tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400"><th className="px-3 py-3">Tag</th><th className="px-3 py-3">ID</th><th className="px-3 py-3 text-right">Events</th><th className="px-3 py-3 text-right">Last Seen</th></tr></thead>
              <tbody>
                {topMoving.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">No movement data.</td></tr> : topMoving.map((tag) => <tr key={tag.tagId} className="border-b border-slate-50 last:border-0"><td className="px-3 py-4 font-semibold text-slate-700">{tag.tagName || "Unnamed tag"}</td><td className="px-3 py-4 font-mono text-xs text-slate-500">{tag.tagId}</td><td className="px-3 py-4 text-right font-semibold">{tag.events.toLocaleString()}</td><td className="px-3 py-4 text-right text-slate-500">{new Date(tag.lastSeen).toLocaleString()}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, accent = "slate", textValue = false }: { label: string; value: number | string; accent?: string; textValue?: boolean }) {
  const valueClass = accent === "emerald" ? "text-emerald-600" : accent === "rose" ? "text-rose-600" : accent === "cyan" ? "text-cyan-600" : "text-slate-900";
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className={`mt-3 font-bold ${textValue ? "text-xl" : "text-3xl"} ${valueClass}`}>{typeof value === "number" ? value.toLocaleString() : value}</p></div>;
}

function DistributionCard({ title, items }: { title: string; items: Distribution[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">{title}</h2><div className="mt-5 space-y-4">{items.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">No data.</p> : items.slice(0, 8).map((item) => <div key={`${item.id}-${item.name}`}><div className="mb-1.5 flex justify-between gap-3 text-sm"><span className="truncate font-medium text-slate-700">{item.name}</span><span className="shrink-0 text-slate-500">{item.count} <span className="text-emerald-600">({item.online} online)</span></span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }} /></div></div>)}</div></div>;
}
