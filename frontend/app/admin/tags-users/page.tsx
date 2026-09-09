"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Role = "user" | "admin";
type TagStatus = "ONLINE" | "OFFLINE";
type User = { id: string; username: string; role: Role; lastLoginAt?: string | null; createdAt?: string | null };
type Tag = { id: string; tagId: string; tagName?: string | null; groupId?: string | number | null; groupName?: string | null; buildingId?: string | null; floorId?: string | null; x?: number | null; y?: number | null; z?: number | null; status: TagStatus; lastSeen?: string | null; movementStatus?: string | null };
type ListResponse<T> = { items: T[] };

const CONTROL = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100";
const PRIMARY = "rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40";
const SECONDARY = "rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50";

function formatDate(value?: string | null) { if (!value) return "Never"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString(); }
function relativeTime(value?: string | null) { if (!value) return "Never"; const time = new Date(value).getTime(); if (!Number.isFinite(time)) return "Unknown"; const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000)); if (seconds < 60) return `${seconds}s ago`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; }

export default function TagsUsersPage() {
  const [tab, setTab] = useState<"tags" | "users">("tags");
  const [tags, setTags] = useState<Tag[]>([]); const [users, setUsers] = useState<User[]>([]);
  const [tagSearch, setTagSearch] = useState(""); const [userSearch, setUserSearch] = useState("");
  const [tagStatus, setTagStatus] = useState<"ALL" | TagStatus>("ALL"); const [groupFilter, setGroupFilter] = useState("ALL");
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState<Role>("user");
  const [saving, setSaving] = useState(false); const [editingUser, setEditingUser] = useState<User | null>(null); const [newPassword, setNewPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [tagResponse, userResponse] = await Promise.all([
        fetch("/api/admin/tags?limit=500", { cache: "no-store", credentials: "include" }),
        fetch(`/api/admin/users?limit=500${userSearch.trim() ? `&search=${encodeURIComponent(userSearch.trim())}` : ""}`, { cache: "no-store", credentials: "include" }),
      ]);
      if (!tagResponse.ok) throw new Error(`Failed to load tags (HTTP ${tagResponse.status})`);
      if (!userResponse.ok) throw new Error(`Failed to load users (HTTP ${userResponse.status})`);
      const tagData = (await tagResponse.json()) as ListResponse<Tag>; const userData = (await userResponse.json()) as ListResponse<User>;
      setTags(Array.isArray(tagData.items) ? tagData.items : []); setUsers(Array.isArray(userData.items) ? userData.items : []);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setLoading(false); }
  }, [userSearch]);

  useEffect(() => { void load(); }, [load]);
  const groups = useMemo(() => Array.from(new Set(tags.map((tag) => tag.groupName || "Ungrouped"))).sort(), [tags]);
  const visibleTags = useMemo(() => tags.filter((tag) => {
    const query = tagSearch.trim().toLowerCase();
    const matchesSearch = !query || [tag.tagId, tag.tagName, tag.groupName, tag.buildingId, tag.floorId].some((value) => String(value ?? "").toLowerCase().includes(query));
    return matchesSearch && (tagStatus === "ALL" || tag.status === tagStatus) && (groupFilter === "ALL" || (tag.groupName || "Ungrouped") === groupFilter);
  }), [groupFilter, tagSearch, tagStatus, tags]);
  const visibleUsers = useMemo(() => { const query = userSearch.trim().toLowerCase(); return query ? users.filter((user) => user.username.toLowerCase().includes(query) || user.role.includes(query)) : users; }, [userSearch, users]);
  const onlineTags = tags.filter((tag) => tag.status === "ONLINE").length; const offlineTags = tags.length - onlineTags; const admins = users.filter((user) => user.role === "admin").length;

  async function createUser() {
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/admin/users", { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, role }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; user?: User };
      if (!response.ok) throw new Error(body.error || `Failed to create user (HTTP ${response.status})`);
      if (body.user) setUsers((current) => [...current, body.user!].sort((a, b) => a.username.localeCompare(b.username)));
      setUsername(""); setPassword(""); setRole("user"); setShowCreate(false);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSaving(false); }
  }

  async function changeRole(user: User, nextRole: Role) {
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: nextRole }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; user?: User };
      if (!response.ok) throw new Error(body.error || `Failed to update user (HTTP ${response.status})`);
      if (body.user) setUsers((current) => current.map((item) => item.id === user.id ? body.user! : item));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function resetPassword(user: User) {
    if (!newPassword) return; setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: newPassword }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Failed to reset password (HTTP ${response.status})`);
      setEditingUser(null); setNewPassword("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSaving(false); }
  }

  async function deleteUser(user: User) {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return; setError(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE", credentials: "include", cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Failed to delete user (HTTP ${response.status})`);
      setUsers((current) => current.filter((item) => item.id !== user.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  return <main className="min-h-screen bg-slate-50 text-slate-900"><div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
    <header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><Link href="/home" className="text-sm font-medium text-cyan-600 hover:text-cyan-700">← Back to Home</Link><div className="mt-4 flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-lg text-cyan-600 shadow-sm">⚙</div><div><h1 className="text-3xl font-bold tracking-tight md:text-4xl">Tag / User Management</h1><p className="mt-1 text-sm text-slate-500">Manage application users and inspect the current non-Asset tag inventory.</p></div></div></div><button onClick={() => void load()} className={SECONDARY}>Refresh</button></header>
    {error && <div className="mb-5 flex items-center justify-between rounded-2xl border border-rose-200 bg-white px-4 py-3 text-sm text-rose-700 shadow-sm"><span>{error}</span><button onClick={() => setError(null)} className="font-semibold">Dismiss</button></div>}
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Tracked tags" value={tags.length} detail="Non-Asset" /><Metric label="Online tags" value={onlineTags} detail="Latest timestamp" valueClass="text-emerald-600" /><Metric label="Offline tags" value={offlineTags} detail="Past alive timeout" valueClass={offlineTags ? "text-rose-600" : undefined} /><Metric label="Users / admins" value={`${users.length} / ${admins}`} detail="Application accounts" /></section>
    <div className="mt-7 flex gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"><button onClick={() => setTab("tags")} className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold ${tab === "tags" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Tags</button><button onClick={() => setTab("users")} className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold ${tab === "users" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>Users</button></div>

    {tab === "tags" ? <section className="mt-5 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-center"><input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search tag ID, name, group, building..." className={`flex-1 ${CONTROL}`} /><select value={tagStatus} onChange={(e) => setTagStatus(e.target.value as "ALL" | TagStatus)} className={CONTROL + " lg:w-36"}><option value="ALL">All status</option><option value="ONLINE">Online</option><option value="OFFLINE">Offline</option></select><select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className={CONTROL + " lg:w-44"}><option value="ALL">All groups</option>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select></div><div className="mt-3 flex justify-between text-xs text-slate-400"><span>{visibleTags.length} of {tags.length} tags</span><span>MongoDB · tag_latest</span></div></div>{loading ? <Loading /> : visibleTags.length === 0 ? <Empty text="No tags match the current filters." /> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left"><thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Tag</th><th className="px-5 py-3">Group</th><th className="px-5 py-3">Location</th><th className="px-5 py-3">Position</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Last seen</th></tr></thead><tbody className="divide-y divide-slate-100">{visibleTags.map((tag) => <tr key={tag.id} className="hover:bg-slate-50/70"><td className="px-5 py-4"><p className="font-semibold text-slate-800">{tag.tagName || `Tag ${tag.tagId}`}</p><p className="text-xs text-slate-400">ID {tag.tagId}</p></td><td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{tag.groupName || "Ungrouped"}</span></td><td className="px-5 py-4 text-sm text-slate-600">B{tag.buildingId || "—"} · F{tag.floorId || "—"}</td><td className="px-5 py-4 font-mono text-xs text-slate-500">{tag.x != null && tag.y != null ? `${tag.x}, ${tag.y}${tag.z != null ? `, ${tag.z}` : ""}` : "—"}</td><td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${tag.status === "ONLINE" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{tag.status}</span><p className="mt-1 text-[10px] text-slate-400">{tag.movementStatus || "UNKNOWN"}</p></td><td className="px-5 py-4"><p className="text-xs font-medium text-slate-600">{relativeTime(tag.lastSeen)}</p><p className="mt-1 text-[10px] text-slate-400">{formatDate(tag.lastSeen)}</p></td></tr>)}</tbody></table></div>}</section> : <section className="mt-5 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-3 border-b border-slate-100 p-5 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="font-semibold text-slate-900">Application users</h2><p className="mt-1 text-xs text-slate-400">Passwords are hashed server-side and never returned.</p></div><div className="flex gap-2"><input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Search username..." className={CONTROL + " lg:w-56"} /><button onClick={() => setShowCreate(true)} className={PRIMARY}>+ Add user</button></div></div>{loading ? <Loading /> : visibleUsers.length === 0 ? <Empty text="No users found." /> : <div className="divide-y divide-slate-100">{visibleUsers.map((user) => <div key={user.id} className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between"><div className="flex min-w-0 items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-500">{user.username.slice(0, 1).toUpperCase()}</div><div><p className="font-semibold text-slate-800">{user.username}</p><p className="text-xs text-slate-400">Created {formatDate(user.createdAt)} · Last login {formatDate(user.lastLoginAt)}</p></div></div><div className="flex flex-wrap items-center gap-2"><select value={user.role} onChange={(e) => void changeRole(user, e.target.value as Role)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"><option value="user">User</option><option value="admin">Admin</option></select><button onClick={() => setEditingUser(user)} className={SECONDARY}>Reset password</button><button onClick={() => void deleteUser(user)} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-600 hover:bg-rose-50">Delete</button></div></div>)}</div>}</section>}
  </div>
  {showCreate && <Modal title="Create user" onClose={() => setShowCreate(false)}><div className="space-y-4"><Field label="Username"><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" className={CONTROL} autoComplete="off" /></Field><Field label="Password"><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Minimum 8 characters" className={CONTROL} autoComplete="new-password" /></Field><Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value as Role)} className={CONTROL}><option value="user">User</option><option value="admin">Admin</option></select></Field><div className="flex justify-end gap-2 pt-2"><button onClick={() => setShowCreate(false)} className={SECONDARY}>Cancel</button><button disabled={saving || !username || password.length < 8} onClick={() => void createUser()} className={PRIMARY}>{saving ? "Creating..." : "Create user"}</button></div></div></Modal>}
  {editingUser && <Modal title={`Reset password · ${editingUser.username}`} onClose={() => { setEditingUser(null); setNewPassword(""); }}><div className="space-y-4"><Field label="New password"><input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} type="password" placeholder="Minimum 8 characters" className={CONTROL} autoComplete="new-password" /></Field><p className="text-xs text-slate-400">Changing the password invalidates the user's existing sessions.</p><div className="flex justify-end gap-2"><button onClick={() => { setEditingUser(null); setNewPassword(""); }} className={SECONDARY}>Cancel</button><button disabled={saving || newPassword.length < 8} onClick={() => void resetPassword(editingUser)} className={PRIMARY}>{saving ? "Saving..." : "Save password"}</button></div></div></Modal>}
  </main>;
}

function Metric({ label, value, detail, valueClass = "text-slate-900" }: { label: string; value: string | number; detail: string; valueClass?: string }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className={`mt-3 text-3xl font-bold ${valueClass}`}>{value}</p><p className="mt-1 text-xs text-slate-400">{detail}</p></div>; }
function Loading() { return <div className="p-12 text-center text-sm text-slate-400">Loading...</div>; }
function Empty({ text }: { text: string }) { return <div className="p-12 text-center text-sm text-slate-400">{text}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</span>{children}</label>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-900/30 p-4"><div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-bold text-slate-900">{title}</h2><button onClick={onClose} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-500">✕</button></div>{children}</div></div>; }
