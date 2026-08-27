"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const defaults = { stats: true, tags: true, places: true, buildings: true, api: true };
type Panel = keyof typeof defaults;

export default function AdminPage() {
  const [panels, setPanels] = useState(defaults);

  useEffect(() => {
    const saved = localStorage.getItem("adminPanelVisibility");
    if (saved) {
      try { setPanels({ ...defaults, ...JSON.parse(saved) }); } catch {}
    }
  }, []);

  const toggle = (panel: Panel) => {
    const next = { ...panels, [panel]: !panels[panel] };
    setPanels(next);
    localStorage.setItem("adminPanelVisibility", JSON.stringify(next));
  };

  const reset = () => {
    setPanels(defaults);
    localStorage.setItem("adminPanelVisibility", JSON.stringify(defaults));
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div><p className="text-sm font-semibold text-violet-600">ADMIN</p><h1 className="text-4xl font-bold">Dashboard Configuration</h1><p className="mt-2 text-slate-500">Control what normal users see on the main page.</p></div>
          <Link href="/" className="rounded-xl bg-slate-800 px-5 py-3 text-sm font-semibold text-white">Main page</Link>
        </header>

        <section className="rounded-3xl border border-violet-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">Page panels</h2><p className="mt-1 text-sm text-slate-400">Green = visible to normal users · Red = hidden</p></div><button onClick={reset} className="rounded-xl border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Reset all</button></div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {(Object.keys(panels) as Panel[]).map((panel) => <button key={panel} onClick={() => toggle(panel)} className={`rounded-2xl border p-5 text-left ${panels[panel] ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}><div className="flex justify-between"><span className="font-semibold capitalize">{panel}</span><span className={`rounded-full px-2 py-1 text-xs font-bold ${panels[panel] ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{panels[panel] ? "SHOW" : "HIDE"}</span></div><p className="mt-3 text-xs text-slate-500">{panels[panel] ? "Normal users can see this panel." : "Hidden from normal users."}</p></button>)}
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <Info title="Dashboard" text="Control statistics, tags, places and buildings." />
          <Info title="Operations" text="Keep online/offline information available to users." />
          <Info title="API visibility" text="Hide technical API information from normal users." />
        </section>
      </div>
    </main>
  );
}

function Info({ title, text }: { title: string; text: string }) { return <div className="rounded-2xl border bg-white p-5"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm text-slate-400">{text}</p></div>; }
