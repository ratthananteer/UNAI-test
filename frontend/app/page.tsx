"use client";

import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const login = (role: "user" | "admin") => {
    localStorage.setItem("userRole", role);
    router.push(role === "admin" ? "/admin" : "/home");
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-50 text-2xl text-cyan-600">⌖</div>
          <h1 className="text-3xl font-bold text-slate-900">Location Platform</h1>
          <p className="mt-2 text-sm text-slate-400">Demo login — no username or password required.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => login("user")} className="rounded-2xl border border-cyan-200 bg-cyan-50 p-5 text-left transition hover:bg-cyan-100">
            <div className="text-2xl">👤</div>
            <p className="mt-2 font-bold text-slate-800">Normal User</p>
            <p className="mt-1 text-xs text-slate-400">Open Home page</p>
          </button>
          <button type="button" onClick={() => login("admin")} className="rounded-2xl border border-violet-200 bg-violet-50 p-5 text-left transition hover:bg-violet-100">
            <div className="text-2xl">🛠️</div>
            <p className="mt-2 font-bold text-slate-800">Admin User</p>
            <p className="mt-1 text-xs text-slate-400">Open Admin page</p>
          </button>
        </div>
      </div>
    </main>
  );
}
