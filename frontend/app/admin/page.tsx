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
  const [cleanupSecret, setCleanupSecret] = useState("");
  const [cleanupCount, setCleanupCount] = useState<number | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<number | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [cleanupError, setCleanupError] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  // Some browser extensions inject attributes such as `fdprocessedid` into
  // form controls before React hydrates. Do not SSR the interactive admin
  // controls; render the same lightweight shell on server and first client
  // render, then mount the controls after hydration.
  if (!mounted) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900">
        <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-10">
          <section className="rounded-3xl border border-slate-800 bg-slate-100 p-6 shadow-xl">
            <div className="h-4 w-40 animate-pulse rounded bg-slate-300" />
            <div className="mt-4 h-10 w-80 animate-pulse rounded bg-slate-200" />
            <div className="mt-3 h-4 w-full max-w-2xl animate-pulse rounded bg-slate-200" />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-10">
        <header className="mb-8 flex flex-col gap-5 rounded-3xl border border-slate-800 bg-slate-100 p-6 shadow-xl md:flex-row md:items-center md:justify-between">
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
          <div className="mb-6 rounded-2xl border border-amber-700/50 bg-amber-100/40 px-5 py-4 text-sm text-amber-200">
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

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-800 bg-slate-50 shadow-xl">
          <div className="border-b border-slate-800 p-6">
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

          <div className="grid gap-px bg-slate-300 md:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(PANEL_INFO) as PanelKey[]).map((key) => {
              const info = PANEL_INFO[key];
              const enabled = panels[key];

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggle(key)}
                  aria-pressed={enabled}
                  className="bg-slate-100 p-5 text-left transition hover:bg-slate-850"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-200 text-cyan-400">
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

          <div className="flex items-center justify-between border-t border-slate-800 px-6 py-4">
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

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-300 bg-slate-100 shadow-xl">
          <div className="border-b border-slate-300 bg-slate-200 p-6">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-900">Database maintenance</p>
            <h2 className="mt-1 text-xl font-bold text-black">Tag history cleanup</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Permanently delete TagEvent history received more than 30 minutes ago. TagLatest is preserved, so current tag status and locations are not deleted.
            </p>
          </div>

          <div className="grid gap-5 p-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label htmlFor="admin-cleanup-secret" className="text-sm font-semibold text-slate-500">
                Admin cleanup secret
              </label>
              <input
                id="admin-cleanup-secret"
                type="password"
                value={cleanupSecret}
                onChange={(event) => {
                  setCleanupSecret(event.target.value);
                  setCleanupError("");
                  setCleanupMessage("");
                }}
                placeholder="Enter ADMIN_CLEANUP_SECRET"
                autoComplete="off"
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-100 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20"
              />
              <p className="mt-2 text-xs text-slate-500">
                The secret is kept only in this page's memory and is sent in the request header. It is not saved to localStorage.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 lg:justify-end">
              <button
                type="button"
                disabled={cleanupLoading || !cleanupSecret.trim()}
                onClick={async () => {
                  setCleanupLoading(true);
                  setCleanupError("");
                  setCleanupMessage("");
                  setCleanupCount(null);
                  try {
                    const response = await fetch("/api/admin/tag-events/cleanup-preview", {
                      headers: { "x-admin-cleanup-secret": cleanupSecret.trim() },
                      cache: "no-store",
                    });
                    const data: unknown = await response.json().catch(() => null);
                    if (!response.ok) {
                      const message = data && typeof data === "object" && "error" in data
                        ? String((data as { error?: unknown }).error ?? `HTTP ${response.status}`)
                        : `HTTP ${response.status}`;
                      throw new Error(message);
                    }
                    const count = data && typeof data === "object" && "eligibleCount" in data
                      ? Number((data as { eligibleCount?: unknown }).eligibleCount)
                      : 0;
                    setCleanupPreview(Number.isFinite(count) ? count : 0);
                    setCleanupMessage("Preview updated. No data was deleted.");
                  } catch (error) {
                    setCleanupError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setCleanupLoading(false);
                  }
                }}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Preview
              </button>
              <button
                type="button"
                disabled={cleanupLoading || !cleanupSecret.trim()}
                onClick={async () => {
                  const confirmed = window.confirm(
                    "Delete all TagEvent records received more than 30 minutes ago? This cannot be undone. TagLatest will be preserved.",
                  );
                  if (!confirmed) return;

                  setCleanupLoading(true);
                  setCleanupError("");
                  setCleanupMessage("");
                  setCleanupCount(null);
                  try {
                    const response = await fetch("/api/admin/tag-events/cleanup", {
                      method: "POST",
                      headers: { "x-admin-cleanup-secret": cleanupSecret.trim() },
                    });
                    const data: unknown = await response.json().catch(() => null);
                    if (!response.ok) {
                      const message = data && typeof data === "object" && "error" in data
                        ? String((data as { error?: unknown }).error ?? `HTTP ${response.status}`)
                        : `HTTP ${response.status}`;
                      throw new Error(message);
                    }
                    const count = data && typeof data === "object" && "deletedCount" in data
                      ? Number((data as { deletedCount?: unknown }).deletedCount)
                      : 0;
                    setCleanupCount(Number.isFinite(count) ? count : 0);
                    setCleanupPreview(0);
                    setCleanupMessage("Cleanup completed successfully.");
                  } catch (error) {
                    setCleanupError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setCleanupLoading(false);
                  }
                }}
                className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {cleanupLoading ? "Working..." : "Delete >30 min"}
              </button>
            </div>
          </div>

          <div className="grid gap-3 border-t border-slate-800 bg-slate-200 p-6 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">Retention</p>
              <p className="mt-1 text-lg font-bold text-white">30 minutes</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">Eligible now</p>
              <p className="mt-1 text-lg font-bold text-amber-300">{cleanupPreview === null ? "—" : cleanupPreview}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">Last deleted</p>
              <p className="mt-1 text-lg font-bold text-rose-300">{cleanupCount === null ? "—" : cleanupCount}</p>
            </div>
          </div>

          {(cleanupMessage || cleanupError) && (
            <div className={`border-t px-6 py-4 text-sm ${cleanupError ? "border-rose-900/50 bg-rose-950/20 text-rose-300" : "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"}`}>
              {cleanupError || cleanupMessage}
            </div>
          )}
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
