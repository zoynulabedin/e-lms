import { data } from "react-router";
import { useLoaderData, useFetcher, Form } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin, hashPassword } from "../utils/auth.server";
import {
  Search,
  ShieldCheck,
  User,
  Briefcase,
  Ban,
  CheckCircle2,
  UserPlus,
  X,
  AlertCircle,
  Eye,
  EyeOff,
  ChevronLeft,
  ChevronRight,
  Monitor,
  Smartphone,
  LogOut,
  Wifi,
  Clock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";

const PER_PAGE = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBrowser(ua: string): string {
  if (/Edg/i.test(ua)) return "Edge";
  if (/OPR|Opera/i.test(ua)) return "Opera";
  if (/Chrome/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Safari/i.test(ua)) return "Safari";
  return "Browser";
}

function parseOS(ua: string): string {
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS/i.test(ua)) return "macOS";
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown OS";
}

function isMobile(ua: string): boolean {
  return /iPhone|iPad|Android|Mobile/i.test(ua);
}

function timeAgo(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const roleFilter = url.searchParams.get("role") || "ALL";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const skip = (page - 1) * PER_PAGE;

  const where = {
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { name: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(roleFilter !== "ALL" ? { role: roleFilter as any } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { licenses: true, progress: true } },
        sessions: {
          where: { isActive: true, expiresAt: { gt: new Date() } },
          orderBy: { lastActiveAt: "desc" },
          select: { id: true, ipAddress: true, userAgent: true, lastActiveAt: true, createdAt: true, deviceId: true },
        },
      },
      take: PER_PAGE,
      skip,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, q, roleFilter, page, totalPages: Math.ceil(total / PER_PAGE), total };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const userId = String(formData.get("userId") || "");

  if (intent === "create_user") {
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const password = String(formData.get("password") || "");
    const role = (formData.get("role") as string) || "STUDENT";

    if (!name || !email || password.length < 8) {
      return data(
        { error: "Name, email, and a password of at least 8 characters are required." },
        { status: 400 },
      );
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return data({ error: "An account with this email already exists." }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);
    await prisma.user.create({ data: { name, email, passwordHash, role: role as any } });
    return data({ success: true, created: true });
  }

  if (intent === "change_role") {
    const role = formData.get("role") as "ADMIN" | "STUDENT" | "CORPORATE";
    await prisma.user.update({ where: { id: userId }, data: { role } });
    return data({ success: true });
  }

  if (intent === "change_max_devices") {
    const maxDevices = parseInt(String(formData.get("maxDevices") || "1"), 10);
    await prisma.user.update({ where: { id: userId }, data: { maxDevices } });
    return data({ success: true });
  }

  if (intent === "revoke_session") {
    const sessionId = String(formData.get("sessionId") || "");
    await prisma.userSession.updateMany({ where: { id: sessionId }, data: { isActive: false } });
    return data({ success: true });
  }

  if (intent === "revoke_all_sessions") {
    await prisma.userSession.updateMany({ where: { userId }, data: { isActive: false } });
    return data({ success: true });
  }

  if (intent === "revoke_all") {
    await prisma.license.updateMany({ where: { userId }, data: { status: "REVOKED" } });
    return data({ success: true });
  }

  if (intent === "ban_user") {
    const reason = (formData.get("reason") as string)?.trim() || null;
    await prisma.userSession.updateMany({ where: { userId }, data: { isActive: false } });
    await prisma.user.update({ where: { id: userId }, data: { isBanned: true, banReason: reason, isSuspended: false } });
    return data({ success: true });
  }

  if (intent === "suspend_user") {
    await prisma.userSession.updateMany({ where: { userId }, data: { isActive: false } });
    await prisma.user.update({ where: { id: userId }, data: { isSuspended: true } });
    return data({ success: true });
  }

  if (intent === "unban_user") {
    await prisma.user.update({ where: { id: userId }, data: { isBanned: false, isSuspended: false, banReason: null } });
    return data({ success: true });
  }

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const roleIcon: Record<string, React.ElementType> = {
  ADMIN: ShieldCheck,
  STUDENT: User,
  CORPORATE: Briefcase,
};
const roleColor: Record<string, string> = {
  ADMIN: "bg-purple-100 text-purple-800",
  STUDENT: "bg-blue-100 text-blue-800",
  CORPORATE: "bg-amber-100 text-amber-800",
};

// ── Create User Modal ─────────────────────────────────────────────────────────

function CreateUserModal({ onClose, fetcher }: { onClose: () => void; fetcher: any }) {
  const [showPw, setShowPw] = useState(false);
  const result = fetcher.data as any;
  const isSubmitting = fetcher.state === "submitting";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/60">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <UserPlus size={16} className="text-[#008060]" /> Create New User
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        <fetcher.Form method="post" className="p-6 space-y-4" onSubmit={() => result?.created && setTimeout(onClose, 150)}>
          <input type="hidden" name="intent" value="create_user" />

          {result?.error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">
              <AlertCircle size={14} className="shrink-0" /> {result.error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input name="name" type="text" required autoFocus placeholder="Jane Smith"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#008060] focus:ring-1 focus:ring-[#008060]" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Email Address <span className="text-red-500">*</span>
            </label>
            <input name="email" type="email" required placeholder="jane@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#008060] focus:ring-1 focus:ring-[#008060]" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Password <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input name="password" type={showPw ? "text" : "password"} required minLength={8} placeholder="Min. 8 characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-9 text-sm focus:outline-none focus:border-[#008060] focus:ring-1 focus:ring-[#008060]" />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute inset-y-0 right-2.5 flex items-center text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Role</label>
            <select name="role" defaultValue="STUDENT"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#008060]">
              <option value="STUDENT">Student</option>
              <option value="ADMIN">Admin</option>
              <option value="CORPORATE">Corporate</option>
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting}
              className="px-5 py-2 text-sm font-medium text-white bg-[#008060] rounded-lg hover:bg-[#006e52] disabled:opacity-60 shadow-sm">
              {isSubmitting ? "Creating…" : "Create User"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ── Sessions Panel ────────────────────────────────────────────────────────────

function SessionsPanel({ user, fetcher }: { user: any; fetcher: any }) {
  const sessions: any[] = user.sessions ?? [];

  if (sessions.length === 0) {
    return (
      <div className="px-6 py-4 text-xs text-gray-400 italic">No active sessions.</div>
    );
  }

  return (
    <div className="px-6 py-3 space-y-2">
      {sessions.map((session: any) => {
        const ua = session.userAgent || "";
        const browser = parseBrowser(ua);
        const os = parseOS(ua);
        const mobile = isMobile(ua);
        const DeviceIcon = mobile ? Smartphone : Monitor;

        return (
          <div key={session.id} className="flex items-center gap-3 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
            <DeviceIcon size={16} className="text-gray-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800">{browser} on {os}</p>
              <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                <span className="flex items-center gap-1 text-[11px] text-gray-400">
                  <Wifi size={10} /> {session.ipAddress || "Unknown IP"}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-gray-400">
                  <Clock size={10} /> Last active {timeAgo(session.lastActiveAt)}
                </span>
              </div>
            </div>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="revoke_session" />
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="sessionId" value={session.id} />
              <button
                type="submit"
                title="Revoke this session"
                className="flex items-center gap-1 text-[11px] text-red-500 hover:text-red-700 hover:bg-red-50 border border-red-100 hover:border-red-200 px-2 py-1 rounded-md transition-colors shrink-0"
              >
                <LogOut size={11} /> Revoke
              </button>
            </fetcher.Form>
          </div>
        );
      })}

      {sessions.length > 1 && (
        <fetcher.Form method="post" className="pt-1">
          <input type="hidden" name="intent" value="revoke_all_sessions" />
          <input type="hidden" name="userId" value={user.id} />
          <button
            type="submit"
            onClick={(e) => { if (!confirm("Sign out this user from all devices?")) e.preventDefault(); }}
            className="text-xs text-red-500 hover:text-red-700 font-medium"
          >
            Revoke all sessions ({sessions.length})
          </button>
        </fetcher.Form>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const { users, q, roleFilter, page, totalPages, total } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const createFetcher = useFetcher<typeof action>();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const createResult = createFetcher.data as any;

  if (createResult?.created && showCreate) {
    setTimeout(() => setShowCreate(false), 300);
  }

  function toggleSessions(userId: string) {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} total users</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-[#008060] text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-[#006e52] transition-colors shadow-sm">
          <UserPlus size={15} /> Create User
        </button>
      </div>

      {/* Success banner */}
      {createResult?.created && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} /> User created successfully.
        </div>
      )}

      {/* Filters */}
      <Form method="get" className="flex flex-wrap gap-3 items-center bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 inset-y-0 my-auto text-gray-400" />
          <input name="q" defaultValue={q} type="text" placeholder="Search name or email…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#008060] focus:border-transparent" />
        </div>
        <select name="role" defaultValue={roleFilter}
          className="text-sm border-gray-300 rounded-md shadow-sm focus:border-[#008060] py-1.5 pl-3 pr-8">
          <option value="ALL">All Roles</option>
          <option value="ADMIN">Admin</option>
          <option value="STUDENT">Student</option>
          <option value="CORPORATE">Corporate</option>
        </select>
        <button type="submit" className="bg-[#008060] text-white px-4 py-1.5 rounded-md text-sm font-medium hover:bg-[#006e52] transition-colors">
          Search
        </button>
      </Form>

      {/* Table */}
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {["User", "Role", "Status", "Devices", "Device Limit", "Licenses", "Courses", "Joined", "Actions"].map(h => (
                  <th key={h} scope="col" className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200 text-sm">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-10 text-center text-gray-400">No users found.</td>
                </tr>
              ) : (
                users.map((user: any) => {
                  const RoleIcon = roleIcon[user.role] || User;
                  const activeSessions: any[] = user.sessions ?? [];
                  const activeCount = activeSessions.length;
                  const maxDevices = user.maxDevices ?? 1;
                  const isExpanded = expandedSessions.has(user.id);
                  const atLimit = maxDevices > 0 && activeCount >= maxDevices;

                  return (
                    <>
                      <tr key={user.id} className={`hover:bg-gray-50 ${user.isBanned || user.isSuspended ? "opacity-60" : ""}`}>
                        {/* User */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#008060]/10 text-[#008060] flex items-center justify-center font-bold text-sm shrink-0">
                              {user.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{user.name}</p>
                              <p className="text-gray-500 text-xs">{user.email}</p>
                            </div>
                          </div>
                        </td>

                        {/* Role */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${roleColor[user.role]}`}>
                            <RoleIcon size={11} /> {user.role}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          {user.isBanned ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                              <Ban size={10} /> Banned
                            </span>
                          ) : user.isSuspended ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                              Suspended
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                              <CheckCircle2 size={10} /> Active
                            </span>
                          )}
                        </td>

                        {/* Active Devices */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => toggleSessions(user.id)}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                              activeCount === 0
                                ? "text-gray-400 border-gray-200 hover:bg-gray-50"
                                : atLimit
                                ? "text-red-600 bg-red-50 border-red-200 hover:bg-red-100"
                                : "text-blue-600 bg-blue-50 border-blue-200 hover:bg-blue-100"
                            }`}
                          >
                            <Monitor size={11} />
                            {activeCount} active
                            {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                          </button>
                        </td>

                        {/* Device Limit */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <fetcher.Form method="post" className="flex items-center gap-2">
                            <input type="hidden" name="intent" value="change_max_devices" />
                            <input type="hidden" name="userId" value={user.id} />
                            <input
                              type="number"
                              name="maxDevices"
                              defaultValue={maxDevices}
                              min={0}
                              title="0 = unlimited"
                              className="w-16 text-sm border-gray-300 rounded shadow-sm focus:border-[#008060] py-1 px-2 text-center"
                              onBlur={(e) => { if (e.target.value !== String(maxDevices)) fetcher.submit(e.target.form!); }}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                            />
                          </fetcher.Form>
                        </td>

                        {/* Licenses / Courses / Joined */}
                        <td className="px-5 py-3 whitespace-nowrap text-gray-700">{user._count.licenses}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-gray-700">{user._count.progress}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-gray-500 text-xs">{new Date(user.createdAt).toLocaleDateString()}</td>

                        {/* Actions */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {/* Role */}
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="change_role" />
                              <input type="hidden" name="userId" value={user.id} />
                              <select name="role" defaultValue={user.role}
                                onChange={(e) => fetcher.submit(e.target.form!)}
                                className="text-xs border-gray-300 rounded shadow-sm focus:border-[#008060] py-1 pl-2 pr-6">
                                <option value="ADMIN">Admin</option>
                                <option value="STUDENT">Student</option>
                                <option value="CORPORATE">Corporate</option>
                              </select>
                            </fetcher.Form>

                            {/* Suspend / Restore */}
                            {user.isBanned || user.isSuspended ? (
                              <fetcher.Form method="post">
                                <input type="hidden" name="intent" value="unban_user" />
                                <input type="hidden" name="userId" value={user.id} />
                                <button type="submit" className="text-xs text-green-600 border border-green-200 hover:bg-green-50 px-2 py-1 rounded transition-colors">
                                  Restore
                                </button>
                              </fetcher.Form>
                            ) : (
                              <fetcher.Form method="post" onSubmit={e => { if (!confirm(`Suspend ${user.name}?`)) e.preventDefault(); }}>
                                <input type="hidden" name="intent" value="suspend_user" />
                                <input type="hidden" name="userId" value={user.id} />
                                <button type="submit" className="text-xs text-amber-600 border border-amber-200 hover:bg-amber-50 px-2 py-1 rounded transition-colors">
                                  Suspend
                                </button>
                              </fetcher.Form>
                            )}

                            {/* Revoke all licenses */}
                            <fetcher.Form method="post" onSubmit={e => { if (!confirm("Revoke ALL licenses for this user?")) e.preventDefault(); }}>
                              <input type="hidden" name="intent" value="revoke_all" />
                              <input type="hidden" name="userId" value={user.id} />
                              <button type="submit" title="Revoke all licenses" className="text-red-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 transition-colors">
                                <Ban size={13} />
                              </button>
                            </fetcher.Form>
                          </div>
                        </td>
                      </tr>

                      {/* Sessions panel — expands inline below the user row */}
                      {isExpanded && (
                        <tr key={`${user.id}-sessions`}>
                          <td colSpan={9} className="bg-blue-50/40 border-t border-blue-100">
                            <SessionsPanel user={user} fetcher={fetcher} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50/50">
            <p className="text-xs text-gray-500">Page {page} of {totalPages} — {total} users</p>
            <div className="flex items-center gap-1">
              <Form method="get">
                <input type="hidden" name="q" value={q} />
                <input type="hidden" name="role" value={roleFilter} />
                <input type="hidden" name="page" value={String(page - 1)} />
                <button type="submit" disabled={page <= 1}
                  className="p-1.5 rounded border border-gray-200 text-gray-500 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed">
                  <ChevronLeft size={15} />
                </button>
              </Form>
              <span className="px-2 text-sm font-medium text-gray-700">{page}</span>
              <Form method="get">
                <input type="hidden" name="q" value={q} />
                <input type="hidden" name="role" value={roleFilter} />
                <input type="hidden" name="page" value={String(page + 1)} />
                <button type="submit" disabled={page >= totalPages}
                  className="p-1.5 rounded border border-gray-200 text-gray-500 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed">
                  <ChevronRight size={15} />
                </button>
              </Form>
            </div>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} fetcher={createFetcher} />}
    </div>
  );
}
