"use client";

import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  function login(role: "user" | "admin") {
    localStorage.setItem("userRole", role);

    if (role === "admin") {
      router.push("/admin");
    } else {
      router.push("/home");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl">
        <h1 className="text-3xl font-bold text-slate-900">
          Location Platform
        </h1>

        <p className="mt-2 text-sm text-slate-400">
          Demo login — no username or password required.
        </p>

        <div className="mt-8 grid gap-4">
          <button
            onClick={() => login("user")}
            className="rounded-2xl bg-cyan-50 p-5 text-left hover:bg-cyan-100"
          >
            <div className="text-2xl">👤</div>
            <div className="mt-2 font-bold">Normal User</div>
            <div className="text-sm text-slate-400">
              Open Home
            </div>
          </button>

          <button
            onClick={() => login("admin")}
            className="rounded-2xl bg-violet-50 p-5 text-left hover:bg-violet-100"
          >
            <div className="text-2xl">🛠️</div>
            <div className="mt-2 font-bold">Admin User</div>
            <div className="text-sm text-slate-400">
              Open Admin
            </div>
          </button>
        </div>
      </div>
    </main>
  );
}