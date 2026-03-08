import { useLoaderData, useFetcher, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import {
  Monitor,
  Globe,
  Clock,
  LogOut,
  Shield,
  ShieldOff,
  Ban,
  UserCheck,
  Search,
  AlertTriangle,
  Cpu,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";

const PER_PAGE = 25;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  const where = {
    isActive: true,
    expiresAt: { gt: new Date() },
    ...(q
      ? {
          user: {
            OR: [
              { email: { contains: q, mode: "insensitive" as const } },
              { name: { contains: q, mode: "insensitive" as const } },
            ],
          },
        }
      : {}),
  };

  const [sessions, totalCount, totalActiveSessions, uniqueActiveUsers, bannedUsers, suspendedUsers] =
    await Promise.all([
      prisma.userSession.findMany({
        where,
        include: { user: true },
        orderBy: { lastActiveAt: "desc" },
        take: PER_PAGE,
        skip: (page - 1) * PER_PAGE,
      }),
      prisma.userSession.count({ where }),
      prisma.userSession.count({
        where: { isActive: true, expiresAt: { gt: new Date() } },
      }),
      prisma.userSession
        .findMany({
          where: { isActive: true, expiresAt: { gt: new Date() } },
          select: { userId: true },
          distinct: ["userId"],
        })
        .then((r) => r.length),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { isSuspended: true } }),
    ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));

  return {
    sessions,
    totalPages,
    page,
    totalCount,
    stats: {
      totalActiveSessions,
      uniqueActiveUsers,
      bannedUsers,
      suspendedUsers,
    },
    q,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "force_logout_session") {
    const sessionId = formData.get("sessionId") as string;
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { isActive: false },
    });
    return data({ success: true });
  }

  if (intent === "force_logout_all") {
    const userId = formData.get("userId") as string;
    await prisma.userSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    return data({ success: true });
  }

  if (intent === "ban_user") {
    const userId = formData.get("userId") as string;
    const reason = (formData.get("reason") as string)?.trim() || null;
    // Invalidate all their sessions first
    await prisma.userSession.updateMany({
      where: { userId },
      data: { isActive: false },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { isBanned: true, banReason: reason, isSuspended: false },
    });
    return data({ success: true });
  }

  if (intent === "suspend_user") {
    const userId = formData.get("userId") as string;
    // Invalidate sessions
    await prisma.userSession.updateMany({
      where: { userId },
      data: { isActive: false },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { isSuspended: true },
    });
    return data({ success: true });
  }

  if (intent === "unban_user") {
    const userId = formData.get("userId") as string;
    await prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, isSuspended: false, banReason: null },
    });
    return data({ success: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(date: string | Date) {
  const now = Date.now();
  const d = new Date(date).getTime();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function parseUA(ua: string) {
  if (!ua || ua === "unknown") return "Unknown device";
  const browser = ua.match(
    /(Chrome|Firefox|Safari|Edge|Opera|Brave)[/\s]([\d.]+)/i,
  );
  const os = ua.match(/(Windows|Mac OS X|Linux|Android|iOS)/i);
  return [browser?.[1], os?.[1]].filter(Boolean).join(" on ") || "Unknown";
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SessionsManagement() {
  const { sessions, stats, q, page, totalPages, totalCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const [searchVal, setSearchVal] = useState(q);
  const [banModal, setBanModal] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  const [banReason, setBanReason] = useState("");

  return (
    <div className="space-y-7">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Shield size={22} className="text-[#008060]" />
            Login Sessions
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Monitor active sessions and control device access
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: "Active Sessions",
            value: stats.totalActiveSessions,
            icon: Monitor,
            color: "text-blue-600",
            bg: "bg-blue-50",
            border: "border-blue-100",
          },
          {
            label: "Unique Users Online",
            value: stats.uniqueActiveUsers,
            icon: UserCheck,
            color: "text-green-600",
            bg: "bg-green-50",
            border: "border-green-100",
          },
          {
            label: "Banned Accounts",
            value: stats.bannedUsers,
            icon: Ban,
            color: "text-red-600",
            bg: "bg-red-50",
            border: "border-red-100",
          },
          {
            label: "Suspended Accounts",
            value: stats.suspendedUsers,
            icon: ShieldOff,
            color: "text-amber-600",
            bg: "bg-amber-50",
            border: "border-amber-100",
          },
        ].map((s) => (
          <div
            key={s.label}
            className={`bg-white rounded-xl p-5 border ${s.border} shadow-sm`}
          >
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-gray-900">{s.value}</p>
            <p className="text-sm text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Security notice */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-800">
            Single-Device Enforcement Active
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            When a user logs in from a new device, all previous sessions are
            automatically invalidated. Use the controls below to manually force
            logout or ban accounts.
          </p>
        </div>
      </div>

      {/* Sessions table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
          <h2 className="text-base font-semibold text-gray-900 flex-1">
            Active Sessions
            <span className="ml-2 text-xs font-normal text-gray-400">
              {totalCount} total
            </span>
          </h2>
          <form method="get" className="flex items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 inset-y-0 my-auto text-gray-400"
              />
              <input
                name="q"
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                type="text"
                placeholder="Search user…"
                className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-[#008060] w-48"
              />
            </div>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {[
                  "User",
                  "Device / Browser",
                  "IP Address",
                  "Last Active",
                  "Session Started",
                  "Actions",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sessions.map((session: any) => (
                <tr key={session.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <div>
                      <p className="font-medium text-gray-900">
                        {session.user.name}
                      </p>
                      <p className="text-xs text-gray-400">
                        {session.user.email}
                      </p>
                      {session.user.isBanned && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                          <Ban size={9} /> BANNED
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Cpu size={13} className="text-gray-400 shrink-0" />
                      <span className="text-xs truncate max-w-[180px]">
                        {parseUA(session.userAgent || "")}
                      </span>
                    </div>
                    {session.deviceId && (
                      <p className="text-[10px] text-gray-400 mt-0.5 font-mono">
                        ID: {session.deviceId}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Globe size={13} className="text-gray-400 shrink-0" />
                      <span className="text-xs font-mono">
                        {session.ipAddress || "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Clock size={12} className="text-gray-400" />
                      {timeAgo(session.lastActiveAt)}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-gray-400 whitespace-nowrap">
                    {new Date(session.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Force logout this session */}
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="force_logout_session"
                        />
                        <input
                          type="hidden"
                          name="sessionId"
                          value={session.id}
                        />
                        <button
                          type="submit"
                          className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50 px-2 py-1 rounded-lg border border-transparent hover:border-amber-200 transition-colors"
                        >
                          <LogOut size={12} /> Force Logout
                        </button>
                      </fetcher.Form>

                      {/* Force logout ALL for this user */}
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="force_logout_all"
                        />
                        <input
                          type="hidden"
                          name="userId"
                          value={session.userId}
                        />
                        <button
                          type="submit"
                          className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-lg border border-transparent hover:border-red-200 transition-colors"
                          title="Logout all devices for this user"
                        >
                          <LogOut size={12} /> All Devices
                        </button>
                      </fetcher.Form>

                      {/* Ban / Unban */}
                      {session.user.isBanned ? (
                        <fetcher.Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="unban_user"
                          />
                          <input
                            type="hidden"
                            name="userId"
                            value={session.userId}
                          />
                          <button
                            type="submit"
                            className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 hover:bg-green-50 px-2 py-1 rounded-lg border border-transparent hover:border-green-200 transition-colors"
                          >
                            <UserCheck size={12} /> Unban
                          </button>
                        </fetcher.Form>
                      ) : (
                        <button
                          onClick={() =>
                            setBanModal({
                              userId: session.userId,
                              name: session.user.name,
                            })
                          }
                          className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-lg border border-transparent hover:border-red-200 transition-colors"
                        >
                          <Ban size={12} /> Ban
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}

              {sessions.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-5 py-12 text-center text-gray-400"
                  >
                    <Monitor className="mx-auto w-10 h-10 mb-2 opacity-30" />
                    <p>No active sessions found.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50">
            <span className="text-xs text-gray-500">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              {(() => {
                const prevParams = new URLSearchParams();
                if (q) prevParams.set("q", q);
                prevParams.set("page", String(page - 1));
                const nextParams = new URLSearchParams();
                if (q) nextParams.set("q", q);
                nextParams.set("page", String(page + 1));
                return (
                  <>
                    <a
                      href={`?${prevParams.toString()}`}
                      aria-disabled={page <= 1}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                        page <= 1
                          ? "border-gray-200 text-gray-300 cursor-not-allowed pointer-events-none"
                          : "border-gray-300 text-gray-700 hover:bg-white"
                      }`}
                    >
                      <ChevronLeft size={13} /> Prev
                    </a>
                    <a
                      href={`?${nextParams.toString()}`}
                      aria-disabled={page >= totalPages}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                        page >= totalPages
                          ? "border-gray-200 text-gray-300 cursor-not-allowed pointer-events-none"
                          : "border-gray-300 text-gray-700 hover:bg-white"
                      }`}
                    >
                      Next <ChevronRight size={13} />
                    </a>
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Ban Modal */}
      {banModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm border border-gray-100">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Ban size={16} className="text-red-500" />
                Ban User
              </h3>
            </div>
            <fetcher.Form
              method="post"
              className="p-6 space-y-4"
              onSubmit={() => {
                setTimeout(() => setBanModal(null), 200);
                setBanReason("");
              }}
            >
              <input type="hidden" name="intent" value="ban_user" />
              <input type="hidden" name="userId" value={banModal.userId} />
              <p className="text-sm text-gray-600">
                You are about to ban{" "}
                <strong className="text-gray-900">{banModal.name}</strong>. This
                will immediately invalidate all their sessions.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Ban Reason{" "}
                  <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  name="reason"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="e.g. Sharing account credentials"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setBanModal(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
                >
                  Ban Account
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}
    </div>
  );
}
