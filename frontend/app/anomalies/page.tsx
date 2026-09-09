"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Status = "OPEN" | "RESOLVED";
type Anomaly = { _id: string; tagId: string; tagName?: string | null; buildingId?: string | null; floorId?: string | null; groupName?: string | null; rule: string; severity: Severity; status: Status; message: string; value?: number | null; threshold?: number | null; unit?: string | null; zoneId?: string | null; zoneName?: string | null; x?: number | null; y?: number | null; z?: number | null; previousX?: number | null; previousY?: number | null; timestamp: string; receivedAt?: string };
type ApiResponse = { items: Anomaly[]; limit: number; skip: number; hasMore: boolean };
type DetectorStatus = { enabled: boolean; trackedTags: number; zoneCount: number };

const RULE_LABELS: Record<string, string> = { SPEED_TOO_HIGH: "Speed too high", SUDDEN_POSITION_JUMP: "Sudden position jump", WRONG_ZONE: "Wrong zone", RESTRICTED_ZONE: "Restricted zone", DWELL_TIME: "Dwell time", TAG_STALE: "Tag stale" };
const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PAGE_SIZE = 50;

function ruleLabel(rule: string) { return RULE_LABELS[rule] ?? rule.replaceAll("_", " "); }
function formatDate(value?: string | null) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(); }
function relativeTime(value?: string | null) { if (!value) return "—"; const time = new Date(value).getTime(); if (!Number.isFinite(time)) return "—"; const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000)); if (seconds < 60) return `${seconds}s ago`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; }
function severityClass(severity: Severity) { if (severity === "CRITICAL") return "border-rose-200 bg-rose-50 text-rose-700"; if (severity === "HIGH") return "border-orange-200 bg-orange-50 text-orange-700"; if (severity === "MEDIUM") return "border-amber-200 bg-amber-50 text-amber-700"; return "border-slate-200 bg-slate-50 text-slate-600"; }

export default function AnomaliesPage() {
  const [items, setItems] = useState<Anomaly[]>([]);
  const [detector, setDetector] = useState<DetectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"ALL" | Status>("OPEN");
  const [severity, setSeverity] = useState<"ALL" | Severity>("ALL");
  const [rule, setRule] = useState("ALL");
  const [tagId, setTagId] = useState("");
  const [search, setSearch] = useState("");
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Anomaly | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(skip) });
      if (status !== "ALL") params.set("status", status);
      if (severity !== "ALL") params.set("severity", severity);
      if (rule !== "ALL") params.set("rule", rule);
      if (tagId.trim()) params.set("tagId", tagId.trim());
      const [anomalyResponse, detectorResponse] = await Promise.all([
        fetch(`/api/anomalies?${params.toString()}`, { cache: "no-store", credentials: "include" }),
        fetch("/api/anomalies/status", { cache: "no-store", credentials: "include" }),
      ]);
      if (!anomalyResponse.ok) throw new Error(`Failed to load anomalies (HTTP ${anomalyResponse.status})`);
      const data = (await anomalyResponse.json()) as ApiResponse;
      setItems(Array.isArray(data.items) ? data.items : []); setHasMore(Boolean(data.hasMore));
      if (detectorResponse.ok) setDetector((await detectorResponse.json()) as DetectorStatus);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [severity, rule, skip, status, tagId]);

  useEffect(() => { void load(); }, [load]);

  const ruleOptions = useMemo(() => Array.from(new Set(items.map((item) => item.rule))).sort(), [items]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase(); if (!query) return items;
    return items.filter((item) => [item.tagId, item.tagName, item.message, item.rule, item.zoneName, item.buildingId, item.floorId, item.groupName].some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [items, search]);
  const counts = useMemo(() => ({ critical: items.filter((i) => i.severity === "CRITICAL" && i.status === "OPEN").length, high: items.filter((i) => i.severity === "HIGH" && i.status === "OPEN").length, medium: items.filter((i) => i.severity === "MEDIUM" && i.status === "OPEN").length, resolved: items.filter((i) => i.status === "RESOLVED").length }), [items]);

  async function resolveAnomaly(item: Anomaly) {
    if (item.status === "RESOLVED" || resolving) return; setResolving(item._id);
    try {
      const response = await fetch(`/api/anomalies/${encodeURIComponent(item._id)}/resolve`, { method: "PATCH", credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to resolve anomaly (HTTP ${response.status})`);
      const body = (await response.json()) as { item?: Anomaly };
      if (body.item) { setItems((current) => current.map((entry) => entry._id === item._id ? body.item! : entry)); setSelected((current) => current?._id === item._id ? body.item! : current); }
      else await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setResolving(null); }
  }

  function resetFilters() { setStatus("OPEN"); setSeverity("ALL"); setRule("ALL"); setTagId(""); setSearch(""); setSkip(0); }

  return <main className="min-h-screen bg-slate-50 text-slate-900"><div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
    <header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><Link href="/home" className="text-sm font-medium text-cyan-600 hover:text-cyan-700">← Back to Home</Link><div className="mt-4 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-100 bg-white text-xl text-rose-600 shadow-sm">!</div><div><h1 className="text-3xl font-bold tracking-tight md:text-4xl">Anomaly Center</h1><p className="mt-1 text-sm text-slate-500">Monitor rule-based RTLS anomalies, investigate events, and acknowledge incidents.</p></div></div></div><div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm"><span className={`h-2.5 w-2.5 rounded-full ${detector?.enabled ? "bg-emerald-500" : "bg-slate-300"}`} /><span className="text-sm font-semibold text-slate-700">Detector {detector?.enabled ? "active" : "unavailable"}</span>{detector && <span className="text-xs text-slate-400">{detector.trackedTags} tracked · {detector.zoneCount} zones</span>}</div></header>
    {error && <div className="mb-5 flex items-center justify-between rounded-2xl border border-rose-200 bg-white px-4 py-3 text-sm text-rose-700 shadow-sm"><span>{error}</span><button onClick={() => setError(null)} className="text-xs font-semibold">Dismiss</button></div>}
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><SummaryCard label="Critical open" value={counts.critical} tone="rose" /><SummaryCard label="High open" value={counts.high} tone="orange" /><SummaryCard label="Medium open" value={counts.medium} tone="amber" /><SummaryCard label="Resolved on page" value={counts.resolved} tone="slate" /></section>
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-col gap-3 lg:flex-row lg:items-center"><div className="relative flex-1"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tag, message, zone, building..." className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-100" /></div><input value={tagId} onChange={(e) => { setTagId(e.target.value.replace(/\D/g, "")); setSkip(0); }} placeholder="Tag ID" inputMode="numeric" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 lg:w-28" /><select value={status} onChange={(e) => { setStatus(e.target.value as "ALL" | Status); setSkip(0); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-cyan-400"><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option><option value="ALL">All status</option></select><select value={severity} onChange={(e) => { setSeverity(e.target.value as "ALL" | Severity); setSkip(0); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-cyan-400"><option value="ALL">All severity</option>{SEVERITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select><select value={rule} onChange={(e) => { setRule(e.target.value); setSkip(0); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-cyan-400"><option value="ALL">All rules</option>{ruleOptions.map((value) => <option key={value} value={value}>{ruleLabel(value)}</option>)}</select><button type="button" onClick={resetFilters} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">Reset</button><button type="button" onClick={() => void load()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">Refresh</button></div></section>
    <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-slate-900">Anomaly events</h2><p className="text-xs text-slate-400">Showing {visibleItems.length} event{visibleItems.length === 1 ? "" : "s"} · newest first</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">MongoDB · anomaly_events</span></div>{loading ? <div className="p-12 text-center text-sm text-slate-400">Loading anomaly events...</div> : visibleItems.length === 0 ? <div className="p-12 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">✓</div><h3 className="mt-3 font-semibold text-slate-800">No matching anomalies</h3><p className="mt-1 text-sm text-slate-400">Try another filter or wait for the detector to record a new event.</p></div> : <div className="divide-y divide-slate-100">{visibleItems.map((item) => <button key={item._id} type="button" onClick={() => setSelected(item)} className="block w-full px-5 py-4 text-left transition hover:bg-slate-50"><div className="flex flex-col gap-3 lg:flex-row lg:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${severityClass(item.severity)}`}>{item.severity}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold tracking-wide text-slate-600">{ruleLabel(item.rule)}</span>{item.status === "RESOLVED" && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold tracking-wide text-emerald-700">RESOLVED</span>}</div><p className="mt-2 truncate text-sm font-semibold text-slate-800">{item.message}</p><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400"><span>Tag {item.tagName || item.tagId}</span>{item.buildingId && <span>Building {item.buildingId}</span>}{item.floorId && <span>Floor {item.floorId}</span>}{item.zoneName && <span>Zone {item.zoneName}</span>}</div></div><div className="shrink-0 text-left lg:w-44 lg:text-right"><p className="text-xs font-medium text-slate-600">{relativeTime(item.timestamp)}</p><p className="mt-1 text-[11px] text-slate-400">{formatDate(item.timestamp)}</p></div></div></button>)}</div>}<div className="flex items-center justify-between border-t border-slate-100 px-5 py-4"><span className="text-xs text-slate-400">Page {Math.floor(skip / PAGE_SIZE) + 1}</span><div className="flex gap-2"><button disabled={skip === 0 || loading} onClick={() => setSkip((value) => Math.max(0, value - PAGE_SIZE))} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">Previous</button><button disabled={!hasMore || loading} onClick={() => setSkip((value) => value + PAGE_SIZE)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">Next</button></div></div></section>
  </div>{selected && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}><div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl"><div className="flex items-start justify-between border-b border-slate-100 p-5"><div><div className="flex flex-wrap gap-2"><span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${severityClass(selected.severity)}`}>{selected.severity}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600">{ruleLabel(selected.rule)}</span></div><h2 className="mt-3 text-xl font-bold text-slate-900">{selected.message}</h2></div><button type="button" onClick={() => setSelected(null)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-500 hover:bg-slate-50">✕</button></div><div className="grid gap-3 p-5 sm:grid-cols-2"><Detail label="Tag" value={`${selected.tagName || "Tag"} · ${selected.tagId}`} /><Detail label="Status" value={selected.status} /><Detail label="Building / Floor" value={`${selected.buildingId || "—"} / ${selected.floorId || "—"}`} /><Detail label="Group" value={selected.groupName || "—"} /><Detail label="Zone" value={selected.zoneName ? `${selected.zoneName} (${selected.zoneId || "—"})` : "—"} /><Detail label="Time" value={formatDate(selected.timestamp)} /><Detail label="Value" value={selected.value != null ? `${selected.value} ${selected.unit || ""}`.trim() : "—"} /><Detail label="Threshold" value={selected.threshold != null ? `${selected.threshold} ${selected.unit || ""}`.trim() : "—"} /><Detail label="Position" value={selected.x != null && selected.y != null ? `X ${selected.x} · Y ${selected.y}${selected.z != null ? ` · Z ${selected.z}` : ""}` : "—"} /><Detail label="Previous position" value={selected.previousX != null && selected.previousY != null ? `X ${selected.previousX} · Y ${selected.previousY}` : "—"} /></div><div className="flex justify-end gap-2 border-t border-slate-100 p-5">{selected.status === "OPEN" && <button type="button" disabled={resolving === selected._id} onClick={() => void resolveAnomaly(selected)} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{resolving === selected._id ? "Resolving..." : "Mark resolved"}</button>}<button type="button" onClick={() => setSelected(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">Close</button></div></div></div>}</main>;
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "rose" | "orange" | "amber" | "slate" }) { const classes = tone === "rose" ? "bg-rose-50 text-rose-600" : tone === "orange" ? "bg-orange-50 text-orange-600" : tone === "amber" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-600"; return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-500">{label}</span><span className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${classes}`}>!</span></div><p className="mt-4 text-3xl font-bold text-slate-900">{value}</p></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 break-words text-sm font-semibold text-slate-700">{value}</p></div>; }
