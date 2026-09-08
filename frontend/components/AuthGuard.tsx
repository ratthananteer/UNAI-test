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
      console.log("[AUTH][GUARD] public path, skip session check", { pathname });
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    console.log("[AUTH][GUARD] checking session", { pathname });

    fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "include",
    })
      .then(async (response) => {
        console.log("[AUTH][GUARD] /api/auth/me response", {
          status: response.status,
          ok: response.ok,
        });
        if (!response.ok) throw new Error("unauthenticated");
        return response.json() as Promise<{ authenticated: boolean; user: User }>;
      })
      .then((data) => {
        if (cancelled) return;
        console.log("[AUTH][GUARD] session result", {
          authenticated: data?.authenticated,
          username: data?.user?.username,
          role: data?.user?.role,
        });
        if (!data.authenticated || !data.user) {
          console.log("[AUTH][GUARD] unauthenticated -> redirect /", { pathname });
          router.replace("/");
          return;
        }
        if (pathname.startsWith("/admin") && data.user.role !== "admin") {
          console.log("[AUTH][GUARD] non-admin -> redirect /home", {
            username: data.user.username,
          });
          router.replace("/home");
          return;
        }
        setUser(data.user);
      })
      .catch((error) => {
        console.error("[AUTH][GUARD] session check failed", error);
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
    if (loggingOut) {
      console.log("[AUTH][CLIENT] logout ignored: already logging out");
      return;
    }

    setLoggingOut(true);
    setUser(null);
    console.log("[AUTH][CLIENT] logout button clicked", {
      pathname,
    });
    console.log("[AUTH][CLIENT] sending POST /api/auth/logout");

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });

      const body = await response.text();
      console.log("[AUTH][CLIENT] logout response", {
        status: response.status,
        ok: response.ok,
        body,
      });
    } catch (error) {
      console.error("[AUTH][CLIENT] logout request error", error);
    } finally {
      console.log("[AUTH][CLIENT] redirecting to / after logout");
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
