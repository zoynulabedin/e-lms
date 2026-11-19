import { data } from "react-router";
import { useLoaderData, useFetcher, Form, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin, hashPassword, getCurrentSessionTokenHash } from "../utils/auth.server";
import { revokedFields } from "../utils/license.server";
import { REVOKE_REASON, PLACEHOLDER_EMAIL } from "../utils/license";
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
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

const PER_PAGE = 20;

const ROLES = ["ADMIN", "STUDENT", "CORPORATE"] as const;
type Role = (typeof ROLES)[number];
const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

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
  // A hand-edited ?role=FOO or ?page=abc falls back to the default instead of
  // reaching Prisma as invalid input and turning into a 500.
  const rawRole = url.searchParams.get("role");
  const roleFilter: Role | "ALL" = isRole(rawRole) ? rawRole : "ALL";
  const rawPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const where = {
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { name: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(roleFilter !== "ALL" ? { role: roleFilter } : {}),
  };

  // Counted first so the requested page can be clamped: deleting the last user
  // on the last page would otherwise leave the admin looking at an empty table.
  const total = await prisma.user.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(requestedPage, totalPages);

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    // Loader data is serialized into the page - never ship hashes.
    omit: { passwordHash: true },
    include: {
      _count: { select: { licenses: true, progress: true } },
      sessions: {
        where: { isActive: true, expiresAt: { gt: new Date() } },
        orderBy: { lastActiveAt: "desc" },
        select: { id: true, ipAddress: true, userAgent: true, lastActiveAt: true, createdAt: true, deviceId: true },
      },
    },
    take: PER_PAGE,
    skip: (page - 1) * PER_PAGE,
  });

  return { users, q, roleFilter, page, totalPages, total };
}

// ── Action ────────────────────────────────────────────────────────────────────

/** A row left on screen after its account was deleted (another tab, another admin). */
const userNotFound = () => data({ error: "User not found." }, { status: 404 });

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const userId = String(formData.get("userId") || "");

  // One lookup for the guards below and for every intent that acts on this
  // account, so a userId that no longer exists gets a 404 instead of Prisma's
  // "record not found" 500.
  const target = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, role: true, isBanned: true, isSuspended: true },
      })
    : null;

  // ── Self-lockout guards ───────────────────────────────────────────────────
  // An admin must not be able to remove their own access here, and the last
  // ADMIN account can never be demoted, suspended, banned or deleted -
  // otherwise nobody can get back into the panel without touching the DB.
  const targetsSelf = userId && userId === admin.id;
  const destructive = ["ban_user", "suspend_user", "delete_user", "revoke_all_sessions"].includes(String(intent));
  const demotes =
    (intent === "change_role" || intent === "edit_user") && formData.has("role") && formData.get("role") !== "ADMIN";
  if (targetsSelf && (destructive || demotes)) {
    return data({ error: "You cannot remove your own admin access from this page." }, { status: 400 });
  }
  if ((destructive || demotes) && target?.role === "ADMIN" && !target.isBanned && !target.isSuspended) {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN", isBanned: false, isSuspended: false } });
    if (adminCount <= 1)
      return data({ error: "This is the last active admin account. Promote someone else first." }, { status: 400 });
  }

  if (intent === "create_user") {
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const password = String(formData.get("password") || "");
    const role = formData.get("role") || "STUDENT";

    if (!name || !email || password.length < 8) {
      return data(
        { error: "Name, email, and a password of at least 8 characters are required." },
        { status: 400 },
      );
    }
    if (!isRole(role)) return data({ error: "Invalid role." }, { status: 400 });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return data({ error: "An account with this email already exists." }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);
    try {
      await prisma.user.create({ data: { name, email, passwordHash, role } });
    } catch (e: any) {
      if (e?.code === "P2002")
        return data({ error: "An account with this email already exists." }, { status: 409 });
      throw e;
    }
    return data({ success: true, created: true });
  }

  if (intent === "change_role") {
    if (!target) return userNotFound();
    const role = formData.get("role");
    if (!isRole(role)) return data({ error: "Invalid role." }, { status: 400 });
    await prisma.user.update({ where: { id: userId }, data: { role } });
    return data({ success: true });
  }

  if (intent === "change_max_devices") {
    if (!target) return userNotFound();
    const n = Number.parseInt(String(formData.get("maxDevices") ?? ""), 10);
    if (!Number.isInteger(n) || n < 0 || n > 50)
      return data({ error: "Device limit must be a whole number from 0 (unlimited) to 50." }, { status: 400 });
    await prisma.user.update({ where: { id: userId }, data: { maxDevices: n } });
    // Lowering the limit takes effect now: keep the n most recently active
    // sessions, sign the rest out.
    if (n > 0) {
      const extra = await prisma.userSession.findMany({
        where: { userId, isActive: true },
        orderBy: { lastActiveAt: "desc" },
        skip: n,
        select: { id: true },
      });
      if (extra.length)
        await prisma.userSession.updateMany({
          where: { id: { in: extra.map((x) => x.id) } },
          data: { isActive: false },
        });
    }
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
    if (!target) return userNotFound();
    // Only keys that are still live: one revoked earlier (say by a Shopify
    // refund) keeps the reason and date it was revoked with.
    const { count } = await prisma.license.updateMany({
      where: { userId, status: { not: "REVOKED" } },
      data: revokedFields(REVOKE_REASON.ADMIN),
    });
    if (count === 0) return data({ success: true, message: `${target.email} has no licenses left to revoke.` });
    console.warn(`[users] ${admin.email} revoked ${count} key(s) held by ${target.email}`);
    return data({
      success: true,
      message:
        `${count} license${count > 1 ? "s" : ""} revoked for ${target.email}. ` +
        "Keys can be restored one by one on the License Keys page.",
    });
  }

  if (intent === "ban_user") {
    if (!target) return userNotFound();
    const reason = (formData.get("reason") as string)?.trim() || null;
    await prisma.userSession.updateMany({ where: { userId }, data: { isActive: false } });
    await prisma.user.update({ where: { id: userId }, data: { isBanned: true, banReason: reason, isSuspended: false } });
    return data({ success: true });
  }

  if (intent === "suspend_user") {
    if (!target) return userNotFound();
    await prisma.userSession.updateMany({ where: { userId }, data: { isActive: false } });
    await prisma.user.update({ where: { id: userId }, data: { isSuspended: true } });
    return data({ success: true });
  }

  if (intent === "unban_user") {
    if (!target) return userNotFound();
    await prisma.user.update({ where: { id: userId }, data: { isBanned: false, isSuspended: false, banReason: null } });
    return data({ success: true });
  }

  if (intent === "edit_user") {
    if (!target) return userNotFound();
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const password = String(formData.get("password") || "");
    const role = formData.get("role");

    if (!name || !email) {
      return data({ error: "Name and email are required." }, { status: 400 });
    }
    // Role is optional on edit; when present it must be valid (no silent
    // fallback to STUDENT).
    if (formData.has("role") && !isRole(role)) return data({ error: "Invalid role." }, { status: 400 });
    const conflict = await prisma.user.findFirst({ where: { email, NOT: { id: userId } } });
    if (conflict) return data({ error: "That email is already used by another account." }, { status: 409 });

    const updateData: { name: string; email: string; role?: Role; passwordHash?: string } = { name, email };
    if (isRole(role)) updateData.role = role;
    if (password.length >= 8) {
      updateData.passwordHash = await hashPassword(password);
    } else if (password.length > 0) {
      return data({ error: "New password must be at least 8 characters." }, { status: 400 });
    }

    // Case-only edits are the same mailbox, so they don't count as a change.
    const emailChanged = email !== target.email.toLowerCase();
    // Editing their own account, the admin keeps the session making this
    // request (as on the student settings page). Ending it too would sign them
    // out, and with a typo in the new address nobody could get back in: the
    // old address no longer logs in and a reset link goes to the typo.
    const keep = targetsSelf ? getCurrentSessionTokenHash(request) : null;
    try {
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: updateData }),
        // A password or email change ends every existing session for that
        // account - that is the whole point of resetting a compromised login.
        ...(updateData.passwordHash || emailChanged
          ? [
              prisma.userSession.updateMany({
                where: { userId, isActive: true, ...(keep ? { token: { not: keep } } : {}) },
                data: { isActive: false },
              }),
            ]
          : []),
        // A reset link already mailed to the old address must stop working:
        // that inbox is no longer the account's.
        ...(emailChanged ? [prisma.passwordReset.deleteMany({ where: { userId } })] : []),
      ]);
    } catch (e: any) {
      // The email was taken between the check above and this write.
      if (e?.code === "P2002")
        return data({ error: "That email is already used by another account." }, { status: 409 });
      if (e?.code === "P2025") return userNotFound();
      throw e;
    }
    return data({ success: true, edited: true });
  }

  if (intent === "delete_user") {
    if (!target) return userNotFound();
    // Unticked (the default), keys bought in Shopify go back to unused so the
    // buyer can redeem them again, e.g. to move the seat to someone else.
    // Ticked, they are revoked too - the way to really cut off an abuser,
    // since whoever holds a returned key can simply redeem it again.
    const revokeKeys = formData.get("revokeKeys") === "1";

    // All-or-nothing, and in this order: License -> User is ON DELETE SET NULL,
    // so every licence change has to land while the rows can still be found
    // by userId.
    const result = await prisma.$transaction(async (tx) => {
      // Lock the account row first. A redeem or login for this user running at
      // the same moment then either finishes before us (and its key is handled
      // below) or waits and fails on the deleted account - it cannot slip an
      // ACTIVE key in after the updates for SET NULL to orphan.
      const rows = await tx.$queryRaw<Array<{ email: string }>>`
        SELECT email FROM "User" WHERE id = ${userId} FOR UPDATE
      `;
      const email = rows[0]?.email;
      if (!email) return null;

      await tx.userSession.deleteMany({ where: { userId } });

      const returned = revokeKeys
        ? 0
        : (
            await tx.license.updateMany({
              where: { userId, shopifyOrderId: { not: null }, status: { not: "REVOKED" } },
              data: { status: "PENDING", userId: null, redeemedAt: null },
            })
          ).count;
      // Whatever else they still hold is revoked, with the reason on record.
      const { count: revoked } = await tx.license.updateMany({
        where: { userId, status: { not: "REVOKED" } },
        data: { ...revokedFields(REVOKE_REASON.USER_DELETED), userId: null },
      });
      // Keys revoked earlier keep their own reason; they only lose the holder.
      await tx.license.updateMany({ where: { userId }, data: { userId: null } });

      // Admin-generated keys carry this address because it redeemed them (or
      // they were made out to it) - personal data that goes with the account.
      // Only keys that were redeemed, though: an unredeemed one made out to
      // this address (say a bulk batch whose buyer hands the keys to staff)
      // keeps it, because that address is what keeps it out of "Delete Unused
      // Keys" until its holder redeems it. A redeemed key keeps redeemedAt, so
      // the placeholder can never make it look never issued. `in` +
      // insensitive compiles to an exact LOWER() match; `equals` + insensitive
      // is an ILIKE, where the "_" common in addresses would match any
      // character.
      await tx.license.updateMany({
        where: {
          shopifyOrderId: null,
          redeemedAt: { not: null },
          customerEmail: { in: [email], mode: "insensitive" },
        },
        data: { customerEmail: PLACEHOLDER_EMAIL },
      });

      await tx.user.delete({ where: { id: userId } });
      return { email, returned, revoked };
    });
    if (!result) return userNotFound();

    // There is no audit table in this app; a log line is the minimum record of
    // who deleted whom and where their keys went.
    console.warn(
      `[users] ${admin.email} deleted user ${result.email} ` +
        `(${result.returned} key(s) returned to unused, ${result.revoked} revoked)`,
    );

    const keys = [
      result.returned ? `${result.returned} Shopify key${result.returned > 1 ? "s" : ""} returned to unused` : "",
      result.revoked ? `${result.revoked} key${result.revoked > 1 ? "s" : ""} revoked` : "",
    ].filter(Boolean);
    return data({
      success: true,
      deleted: true,
      message: `User ${result.email} deleted.` + (keys.length ? ` ${keys.join(", ")}.` : ""),
    });
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
            <UserPlus size={16} className="text-brand-navy" /> Create New User
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
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Email Address <span className="text-red-500">*</span>
            </label>
            <input name="email" type="email" required placeholder="jane@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Password <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input name="password" type={showPw ? "text" : "password"} required minLength={8} placeholder="Min. 8 characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-9 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute inset-y-0 right-2.5 flex items-center text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Role</label>
            <select name="role" defaultValue="STUDENT"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy">
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
              className="px-5 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-60 shadow-sm">
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

// ── Edit User Modal ───────────────────────────────────────────────────────────

function EditUserModal({ user, onClose, fetcher }: { user: any; onClose: () => void; fetcher: any }) {
  const [showPw, setShowPw] = useState(false);
  const result = fetcher.data as any;
  const isSubmitting = fetcher.state === "submitting";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/60">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Pencil size={15} className="text-brand-navy" /> Edit User
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={18} />
          </button>
        </div>

        <fetcher.Form method="post" className="p-6 space-y-4">
          <input type="hidden" name="intent" value="edit_user" />
          <input type="hidden" name="userId" value={user.id} />

          {result?.error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">
              <AlertCircle size={14} className="shrink-0" /> {result.error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Full Name <span className="text-red-500">*</span></label>
            <input name="name" type="text" required defaultValue={user.name} placeholder="Jane Smith"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Email Address <span className="text-red-500">*</span></label>
            <input name="email" type="email" required defaultValue={user.email}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              New Password <span className="text-gray-400 font-normal">(leave blank to keep current)</span>
            </label>
            <div className="relative">
              <input name="password" type={showPw ? "text" : "password"} placeholder="Min. 8 characters"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-9 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy" />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute inset-y-0 right-2.5 flex items-center text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Role</label>
            <select name="role" defaultValue={user.role}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy">
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
              className="px-5 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark disabled:opacity-60 shadow-sm">
              {isSubmitting ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ── Delete User Dialog ────────────────────────────────────────────────────────

function DeleteUserDialog({
  user,
  onClose,
  onDone,
}: {
  user: any;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Its own fetcher, not the page's row fetcher: that one is shared by every
  // row form, so an earlier success would still be in its data when this
  // opens and the effect below would close the dialog straight away.
  const fetcher = useFetcher<typeof action>();
  const [revokeKeys, setRevokeKeys] = useState(false);
  const result = fetcher.data as any;
  const busy = fetcher.state !== "idle";

  // Close once the delete has gone through. An error keeps the dialog open so
  // it is read where it was caused.
  useEffect(() => {
    if (fetcher.state === "idle" && result?.deleted) {
      onDone(result.message ?? "User deleted.");
      onClose();
    }
  }, [fetcher.state, result, onClose, onDone]);

  // Not while the delete is in flight: unmounting would drop its result.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const licenses: number = user._count?.licenses ?? 0;
  const courses: number = user._count?.progress ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/60">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Trash2 size={15} className="text-red-600" /> Delete User
          </h3>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <fetcher.Form method="post" className="p-6 space-y-4">
          <input type="hidden" name="intent" value="delete_user" />
          <input type="hidden" name="userId" value={user.id} />

          {result?.error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm">
              <AlertCircle size={14} className="shrink-0" /> {result.error}
            </div>
          )}

          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
            <p className="font-semibold text-gray-900">{user.name}</p>
            <p className="text-gray-500 text-xs mt-0.5">{user.email}</p>
            <p className="text-gray-500 text-xs mt-1">
              {licenses} license{licenses === 1 ? "" : "s"} · {courses} course{courses === 1 ? "" : "s"}
            </p>
          </div>

          <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm space-y-1">
            <p className="font-semibold">This cannot be undone.</p>
            <p className="text-[13px]">
              Their progress, certificates and quiz attempts are deleted permanently, and they are
              signed out of every device.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-gray-200 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors">
            <input
              type="checkbox"
              name="revokeKeys"
              value="1"
              checked={revokeKeys}
              onChange={(e) => setRevokeKeys(e.target.checked)}
              disabled={busy}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 accent-red-600"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Also revoke their keys bought in Shopify</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                {revokeKeys
                  ? "Their keys are revoked and cannot be redeemed again."
                  : "Their Shopify keys go back to unused, so the buyer can redeem them again (for example to move a seat to someone else)."}
              </span>
            </span>
          </label>

          <p className="text-xs text-gray-500">
            Keys that did not come from Shopify (generated on the License Keys page) are revoked either way.
          </p>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60 shadow-sm">
              <Trash2 size={14} /> {busy ? "Deleting…" : "Delete User"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const { users, q, roleFilter, page, totalPages, total } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  // Fresh fetcher per modal open: fetcher.data lingers after a success, which
  // used to auto-close the very next Create/Edit modal 300 ms after opening.
  const [createKey, setCreateKey] = useState(0);
  const [editKey, setEditKey] = useState(0);
  const createFetcher = useFetcher<typeof action>({ key: `create-user-${createKey}` });
  const editFetcher = useFetcher<typeof action>({ key: `edit-user-${editKey}` });
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<any>(null);
  const [deleteUser, setDeleteUser] = useState<any>(null);
  /** Set by the delete dialog once it succeeded, so the page can confirm it after the dialog closed. */
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const createResult = createFetcher.data as any;
  const editResult = editFetcher.data as any;
  const rowResult = fetcher.data as any;

  const openCreate = () => { setCreateKey((k) => k + 1); setShowCreate(true); };
  const openEdit = (u: any) => { setEditKey((k) => k + 1); setEditUser(u); };
  const openDelete = (u: any) => { setNotice(null); setDeleteUser(u); };

  useEffect(() => {
    if (createFetcher.state !== "idle" || !createResult?.created || !showCreate) return;
    const t = setTimeout(() => setShowCreate(false), 300);
    return () => clearTimeout(t);
  }, [createFetcher.state, createResult?.created, showCreate]);

  useEffect(() => {
    if (editFetcher.state !== "idle" || !editResult?.edited || !editUser) return;
    const t = setTimeout(() => setEditUser(null), 300);
    return () => clearTimeout(t);
  }, [editFetcher.state, editResult?.edited, editUser]);

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
        <button onClick={openCreate}
          className="flex items-center gap-2 bg-brand-navy text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-brand-navy-dark transition-colors shadow-sm">
          <UserPlus size={15} /> Create User
        </button>
      </div>

      {/* Row-action errors (self-lockout guard, invalid input, ...) */}
      {rowResult?.error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          <AlertCircle size={15} /> {rowResult.error}
        </div>
      )}

      {/* Success banners */}
      {rowResult?.message && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} /> {rowResult.message}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} className="shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700/60 hover:text-green-900" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {createResult?.created && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} /> User created successfully.
        </div>
      )}
      {editResult?.edited && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} /> User updated successfully.
        </div>
      )}

      {/* Filters */}
      <Form method="get" className="flex flex-wrap gap-3 items-center bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 inset-y-0 my-auto text-gray-400" />
          <input name="q" defaultValue={q} type="text" placeholder="Search name or email…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-navy focus:border-transparent" />
        </div>
        <select name="role" defaultValue={roleFilter}
          className="text-sm border-gray-300 rounded-md shadow-sm focus:border-brand-navy py-1.5 pl-3 pr-8">
          <option value="ALL">All Roles</option>
          <option value="ADMIN">Admin</option>
          <option value="STUDENT">Student</option>
          <option value="CORPORATE">Corporate</option>
        </select>
        <button type="submit" className="bg-brand-navy text-white px-4 py-1.5 rounded-md text-sm font-medium hover:bg-brand-navy-dark transition-colors">
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
                            <div className="w-8 h-8 rounded-full bg-brand-navy/10 text-brand-navy flex items-center justify-center font-bold text-sm shrink-0">
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
                              className="w-16 text-sm border-gray-300 rounded shadow-sm focus:border-brand-navy py-1 px-2 text-center"
                              onBlur={(e) => { if (e.target.value !== String(maxDevices)) fetcher.submit(e.target.form!); }}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                            />
                          </fetcher.Form>
                        </td>

                        {/* Licenses / Courses / Joined */}
                        <td className="px-5 py-3 whitespace-nowrap">
                          <Link
                            to={`/licenses?q=${encodeURIComponent(user.email)}`}
                            title="Show these keys on the License Keys page"
                            className="text-brand-navy hover:underline font-medium"
                          >
                            {user._count.licenses}
                          </Link>
                        </td>
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
                                className="text-xs border-gray-300 rounded shadow-sm focus:border-brand-navy py-1 pl-2 pr-6">
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
                            <fetcher.Form method="post" onSubmit={e => {
                              if (!confirm(`Revoke all of ${user.name}'s licenses? They lose access to those courses right away. Keys can be restored one by one on the License Keys page.`))
                                e.preventDefault();
                            }}>
                              <input type="hidden" name="intent" value="revoke_all" />
                              <input type="hidden" name="userId" value={user.id} />
                              <button type="submit" title="Revoke all licenses" className="text-red-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 transition-colors">
                                <Ban size={13} />
                              </button>
                            </fetcher.Form>

                            {/* Edit */}
                            <button
                              type="button"
                              title="Edit user"
                              onClick={() => openEdit(user)}
                              className="text-gray-400 hover:text-brand-navy p-1.5 rounded hover:bg-green-50 transition-colors"
                            >
                              <Pencil size={13} />
                            </button>

                            {/* Delete */}
                            <button
                              type="button"
                              title="Delete user"
                              onClick={() => openDelete(user)}
                              className="text-gray-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
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

      {/* Edit User Modal */}
      {editUser && <EditUserModal user={editUser} onClose={() => setEditUser(null)} fetcher={editFetcher} />}

      {/* Delete User Dialog */}
      {deleteUser && <DeleteUserDialog user={deleteUser} onClose={() => setDeleteUser(null)} onDone={setNotice} />}
    </div>
  );
}
