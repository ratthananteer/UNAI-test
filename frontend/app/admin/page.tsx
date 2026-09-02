"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PanelKey = "stats" | "tags" | "places" | "buildings" | "api";

type PanelSettings = Record<PanelKey, boolean>;

const DEFAULT_PANELS: PanelSettings = {
  stats: true,
  tags: true,
  places: true,
  buildings: true,
  api: true,
};

const PANEL_INFO: Record<PanelKey, { title: string; description: string; icon: string }> = {
  stats: { title: "Statistics", description: "Online/offline counts and system totals.", icon: "▦" },
  tags: { title: "Tags & locations", description: "Current users, tags, status and locations.", icon: "●" },
  places: { title: "Places", description: "Places available from the backend.", icon: "⌖" },
  buildings: { title: "Buildings", description: "Building cards and navigation.", icon: "▥" },
  api: { title: "API information", description: "Technical endpoint information shown on Home.", icon: "{}" },
};

export default function AdminPage() {
  const [panels, setPanels] = useState<PanelSettings>(DEFAULT_PANELS);
  const [saved, setSaved] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    setRole(localStorage.getItem("userRole"));

    const raw = localStorage.getItem("adminPanelVisibility");
    if (!raw) return;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        setPanels((current) => ({
          ...current,
          ...(parsed as Partial<PanelSettings>),
        }));
      }
    } catch {
      localStorage.removeItem("adminPanelVisibility");
    }
  }, []);

  const visibleCount = useMemo(
    () => Object.values(panels).filter(Boolean).length,
    [panels],
  );

  const updatePanels = (next: PanelSettings) => {
    setPanels(next);
    localStorage.setItem("adminPanelVisibility", JSON.stringify(next));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const toggle = (key: PanelKey) => {
    updatePanels({ ...panels, [key]: !panels[key] });
  };

  const reset = () => updatePanels({ ...DEFAULT_PANELS });

  const setAll = (visible: boolean) => {
    updatePanels({
      stats: visible,
      tags: visible,
      places: visible,
      buildings: visible,
      api: visible,
    });
  };

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-10">
        <header className="mb-8 flex flex-col gap-5 rounded-3xl border border-slate-900 bg-slate-100 p-6 shadow-xl md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Admin Control Center
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              System Administration
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              Configure the dashboard and monitor the current frontend configuration.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/home"
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-700"
            >
              Open Home
            </Link>
            <Link
              href="/"
              className="rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
            >
              Logout
            </Link>
          </div>
        </header>

        {role !== null && role !== "admin" && (
          <div className="mb-6 rounded-2xl border border-amber-700/50 bg-amber-100 px-5 py-4 text-sm text-amber-200">
            This page is currently a frontend demo control panel. The role is stored in
            localStorage and is not server-side authentication.
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric title="Panels visible" value={String(visibleCount)} detail="of 5 dashboard panels" />
          <Metric title="Panels hidden" value={String(5 - visibleCount)} detail="not shown on Home" />
          <Metric title="Storage" value="Local" detail="browser localStorage" />
          <Metric title="Mode" value="Admin" detail="configuration only" />
        </section>

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-900 bg-slate-100 shadow-xl">
          <div className="border-b border-slate-900 p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-cyan-400">
                  Dashboard configuration
                </p>
                <h2 className="mt-1 text-xl font-bold">Home page panels</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Changes apply to the Home page in this browser immediately after refresh.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-800"
                >
                  Show all
                </button>
                <button
                  type="button"
                  onClick={() => setAll(false)}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-800"
                >
                  Hide all
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg border border-rose-800/70 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-950/40"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-px bg-slate-100 md:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(PANEL_INFO) as PanelKey[]).map((key) => {
              const info = PANEL_INFO[key];
              const enabled = panels[key];

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggle(key)}
                  aria-pressed={enabled}
                  className="bg-slate-120 p-5 text-left transition hover:bg-slate-200"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-400 text-cyan-400">
                      {info.icon}
                    </div>
                    <span
                      className={
                        enabled
                          ? "rounded-full bg-emerald-950 px-2.5 py-1 text-[10px] font-bold text-emerald-300"
                          : "rounded-full bg-rose-950 px-2.5 py-1 text-[10px] font-bold text-rose-300"
                      }
                    >
                      {enabled ? "VISIBLE" : "HIDDEN"}
                    </span>
                  </div>

                  <h3 className="mt-5 font-semibold">{info.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {info.description}
                  </p>

                  <div className="mt-4 flex items-center justify-between text-xs">
                    <span className="text-slate-500">
                      Click to {enabled ? "hide" : "show"}
                    </span>
                    <span className={enabled ? "text-emerald-400" : "text-rose-400"}>
                      {enabled ? "● ON" : "○ OFF"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-6 py-4">
            <span className="text-xs text-slate-500">
              Settings key: <code className="text-slate-400">adminPanelVisibility</code>
            </span>
            {saved && (
              <span className="text-xs font-semibold text-emerald-400">
                ✓ Saved
              </span>
            )}
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-3">
          <InfoCard
            title="Live operations"
            text="Home continues to read tag status from the backend MongoDB data. This page only controls dashboard visibility."
          />
          <InfoCard
            title="Historical data"
            text="Tag History is not hidden by these switches. Historical playback and stored TagEvent data remain available separately."
          />
          <InfoCard
            title="Security note"
            text="The current admin role is a frontend demo. Real production authorization should be enforced by the backend, not localStorage."
          />
        </section>
      </div>
    </main>
  );
}

function Metric({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-100 p-5 shadow-lg">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      <p className="mt-2 text-3xl font-bold text-black">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-100 p-5">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-500">{text}</p>
    </div>
  );
}
