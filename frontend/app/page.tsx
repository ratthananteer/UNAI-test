"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [registerMode, setRegisterMode] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (data?.authenticated) router.replace(data.user?.role === "admin" ? "/admin" : "/home");
      })
      .catch(() => undefined);
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    if (registerMode && password !== confirmPassword) {
      setLoading(false);
      setError("Passwords do not match.");
      return;
    }

    try {
      const response = await fetch(registerMode ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerMode ? { username, password } : { username, password, remember }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (registerMode ? "Registration failed" : "Login failed"));
      router.replace(data.user?.role === "admin" ? "/admin" : "/home");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-white px-5 py-10 text-slate-900">
      <div className="pointer-events-none absolute -left-32 -top-32 h-80 w-80 rounded-full bg-cyan-100/70 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-slate-100 blur-3xl" />

      <section className="relative grid w-full max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/70 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="hidden bg-slate-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-lg font-black text-slate-950">U</div>
              <span className="font-bold tracking-tight">UNAI RTLS</span>
            </div>
            <h1 className="mt-20 text-5xl font-bold leading-tight">Know where<br />everything is.</h1>
            <p className="mt-6 max-w-sm text-sm leading-7 text-slate-400">Secure access to your indoor real-time location platform, dashboards and tag history.</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Feature label="Secure" value="JWT + Cookie" />
            <Feature label="Storage" value="MongoDB" />
            <Feature label="Access" value="Role-based" />
          </div>
        </div>

        <div className="p-7 sm:p-10 lg:p-12">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 font-black text-white">U</div><span className="font-bold">UNAI RTLS</span></div>
          </div>
          <div className="mb-8">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-600">{registerMode ? "New account" : "Welcome back"}</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">{registerMode ? "Create an account" : "Sign in"}</h2>
            <p className="mt-2 text-sm text-slate-500">{registerMode ? "Create a normal user account to access the platform." : "Use your account to continue."}</p>
          </div>

          {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <form onSubmit={submit} className="space-y-5">
            <Field label="Username">
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={64} placeholder="your username" className="auth-input" />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={registerMode ? "new-password" : "current-password"} required minLength={8} maxLength={128} placeholder="••••••••" className="auth-input pr-20" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400 hover:text-slate-700">{showPassword ? "Hide" : "Show"}</button>
              </div>
            </Field>
            {registerMode && (
              <Field label="Confirm password">
                <input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength={8} maxLength={128} placeholder="Repeat your password" className="auth-input" />
              </Field>
            )}

            {!registerMode && <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-600">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-slate-900" />
              Remember me for 30 days
            </label>}

            <button disabled={loading} className="w-full rounded-xl bg-slate-950 px-5 py-3.5 text-sm font-bold text-white shadow-lg shadow-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
              {loading ? (registerMode ? "Creating account…" : "Signing in…") : (registerMode ? "Create account" : "Sign in")}
            </button>
          </form>

          <button type="button" onClick={() => { setRegisterMode((value) => !value); setError(""); setConfirmPassword(""); }} className="mt-7 w-full text-center text-sm text-slate-500 hover:text-slate-900">
            {registerMode ? <>Already have an account? <span className="font-bold">Sign in</span></> : <>Don't have an account? <span className="font-bold">Create one</span></>}
          </button>
          <p className="mt-5 text-center text-[11px] leading-5 text-slate-400">{registerMode ? "New accounts are normal users. Admin accounts are provisioned securely by the server." : "Normal users can stay signed in for 30 days. Admin accounts use a session cookie and are not remembered across browser restarts."}</p>
        </div>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>{children}</label>;
}
function Feature({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-xs font-semibold text-slate-200">{value}</p></div>;
}
