"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type User = { id: string; username: string; role: "user" | "admin" };
const PUBLIC_PATHS = ["/", "/register"];

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checking, setChecking] = useState(!PUBLIC_PATHS.includes(pathname));
  const [user, setUser] = useState<User | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (PUBLIC_PATHS.includes(pathname)) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);

    fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("unauthenticated");
        return response.json() as Promise<{ authenticated: boolean; user: User }>;
      })
      .then((data) => {
        if (cancelled) return;
        if (!data.authenticated || !data.user) {
          router.replace("/");
          return;
        }
        if (pathname.startsWith("/admin") && data.user.role !== "admin") {
          router.replace("/home");
          return;
        }
        setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) router.replace("/");
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  async function handleLogout() {
    if (loggingOut) return;

    setLoggingOut(true);
    setUser(null);

    try {
      // The backend invalidates the JWT sessionVersion and the Next.js API
      // proxy also removes the browser-side HttpOnly cookie.
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
    } catch (error) {
      // Logout is intentionally fail-closed on the client. Even if the
      // backend is temporarily unavailable, do not keep showing the private UI.
      console.error("[Auth] logout request error:", error);
    } finally {
      // Force a fresh request to the login page. Do not use router.push/replace
      // here because a client-side transition can preserve stale auth state.
      window.location.replace("/");
    }
  }

  if (PUBLIC_PATHS.includes(pathname)) return <>{children}</>;

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-6">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-slate-900" />
          <p className="mt-4 text-sm font-medium text-slate-500">Checking your session…</p>
        </div>
      </main>
    );
  }

  return (
    <>
      {user && <AuthUserBar user={user} onLogout={handleLogout} loggingOut={loggingOut} />}
      {children}
    </>
  );
}

function AuthUserBar({
  user,
  onLogout,
  loggingOut,
}: {
  user: User;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <div className="fixed right-4 top-4 z-[100] flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="hidden text-right sm:block">
        <p className="text-xs font-semibold text-slate-800">{user.username}</p>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{user.role}</p>
      </div>
      <button
        type="button"
        onClick={onLogout}
        disabled={loggingOut}
        className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loggingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
