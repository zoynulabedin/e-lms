import { data, redirect, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import {
  requireUser,
  hashPassword,
  verifyPassword,
  getCurrentSessionTokenHash,
} from "../utils/auth.server";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";
import {
  Settings,
  User,
  Lock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MonitorSmartphone,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (user.role === "ADMIN") return redirect("/settings");

  const [completedCount, activeSessions] = await Promise.all([
    prisma.progress.count({
      where: { userId: user.id, completedAt: { not: null } },
    }),
    prisma.userSession.count({
      where: { userId: user.id, isActive: true, expiresAt: { gt: new Date() } },
    }),
  ]);

  return { user, hasCertificates: completedCount > 0, activeSessions };
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "update_profile") {
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    if (name.length < 2) {
      return data({ intent, error: "Please enter your name." }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return data({ intent, error: "Please enter a valid email address." }, { status: 400 });
    }
    const conflict = await prisma.user.findFirst({
      where: { email, NOT: { id: user.id } },
      select: { id: true },
    });
    if (conflict) {
      return data({ intent, error: "That email is already used by another account." }, { status: 409 });
    }
    await prisma.user.update({ where: { id: user.id }, data: { name, email } });
    return data({ intent, success: "Profile updated." });
  }

  if (intent === "change_password") {
    const current = String(formData.get("currentPassword") || "");
    const next = String(formData.get("newPassword") || "");
    const confirm = String(formData.get("confirmPassword") || "");

    if (next.length < 8) {
      return data({ intent, error: "New password must be at least 8 characters." }, { status: 400 });
    }
    if (next !== confirm) {
      return data({ intent, error: "New password and confirmation do not match." }, { status: 400 });
    }
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row || !(await verifyPassword(current, row.passwordHash))) {
      return data({ intent, error: "Current password is incorrect." }, { status: 401 });
    }

    const passwordHash = await hashPassword(next);
    const keep = getCurrentSessionTokenHash(request);
    // Set the new password and sign out every OTHER device; this session stays.
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.userSession.updateMany({
        where: { userId: user.id, isActive: true, ...(keep ? { token: { not: keep } } : {}) },
        data: { isActive: false },
      }),
    ]);
    return data({ intent, success: "Password changed. Other devices have been signed out." });
  }

  if (intent === "sign_out_others") {
    const keep = getCurrentSessionTokenHash(request);
    await prisma.userSession.updateMany({
      where: { userId: user.id, isActive: true, ...(keep ? { token: { not: keep } } : {}) },
      data: { isActive: false },
    });
    return data({ intent, success: "All other devices have been signed out." });
  }

  return data({ intent, error: "Unknown action." }, { status: 400 });
}

type ActionResult = { intent: string; error?: string; success?: string };

export default function StudentSettings() {
  const { user, hasCertificates, activeSessions } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar user={user} active="settings" />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar active="settings" certificatesEnabled={hasCertificates} />
          <StudentTopbar
            user={user}
            certificatesEnabled={hasCertificates}
            title="Settings"
            subtitle="Manage your profile and password."
          />

          <div className="max-w-3xl mx-auto px-5 sm:px-8 py-8 lg:py-10 space-y-8">
            {/* Hero */}
            <div>
              <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
                <Settings size={14} />
                Account
              </div>
              <h1 className="font-display text-4xl text-brand-navy">Your settings</h1>
            </div>

            <ProfileCard user={user} />
            <PasswordCard />
            <DevicesCard activeSessions={activeSessions} />
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Notice({ result, intent }: { result: ActionResult | undefined; intent: string }) {
  if (!result || result.intent !== intent) return null;
  if (result.error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
        <AlertCircle size={14} className="shrink-0" /> {result.error}
      </div>
    );
  }
  if (result.success) {
    return (
      <div className="flex items-center gap-2 text-sm text-brand-green-dark bg-brand-green/10 border border-brand-green/30 rounded-lg px-4 py-2.5">
        <CheckCircle2 size={14} className="shrink-0" /> {result.success}
      </div>
    );
  }
  return null;
}

const inputCls =
  "w-full bg-white border border-brand-beige-dark rounded-lg px-4 py-2.5 text-sm text-brand-navy placeholder-brand-navy/40 focus:outline-none focus:border-brand-navy";
const labelCls = "block text-sm font-medium text-brand-navy mb-1.5";
const buttonCls =
  "inline-flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors";

function Card({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-brand-beige-dark bg-white p-6 sm:p-7">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-lg bg-brand-navy/10 flex items-center justify-center shrink-0">
          <Icon className="text-brand-navy w-5 h-5" />
        </div>
        <div>
          <h2 className="font-display text-xl text-brand-navy leading-tight">{title}</h2>
          <p className="text-brand-navy/60 text-sm mt-0.5">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────

function ProfileCard({ user }: { user: { name: string; email: string } }) {
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <Card icon={User} title="Profile" description="Your name appears on certificates and in the dashboard greeting.">
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="update_profile" />
        <Notice result={fetcher.data} intent="update_profile" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="name" className={labelCls}>Full name</label>
            <input id="name" name="name" defaultValue={user.name} required minLength={2} className={inputCls} />
          </div>
          <div>
            <label htmlFor="email" className={labelCls}>Email</label>
            <input id="email" name="email" type="email" defaultValue={user.email} required className={inputCls} />
          </div>
        </div>
        <button type="submit" disabled={busy} className={buttonCls}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
          Save profile
        </button>
      </fetcher.Form>
    </Card>
  );
}

// ── Password ─────────────────────────────────────────────────────────────────

function PasswordCard() {
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <Card icon={Lock} title="Password" description="Changing your password signs you out of every other device.">
      <fetcher.Form
        method="post"
        className="space-y-4"
        key={fetcher.data?.success ? "done" : "editing"} /* clears fields after success */
      >
        <input type="hidden" name="intent" value="change_password" />
        <Notice result={fetcher.data} intent="change_password" />
        <div>
          <label htmlFor="currentPassword" className={labelCls}>Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required className={inputCls} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="newPassword" className={labelCls}>New password</label>
            <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={8} placeholder="Min. 8 characters" className={inputCls} />
          </div>
          <div>
            <label htmlFor="confirmPassword" className={labelCls}>Confirm new password</label>
            <input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} className={inputCls} />
          </div>
        </div>
        <button type="submit" disabled={busy} className={buttonCls}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
          Change password
        </button>
      </fetcher.Form>
    </Card>
  );
}

// ── Devices ──────────────────────────────────────────────────────────────────

function DevicesCard({ activeSessions }: { activeSessions: number }) {
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <Card
      icon={MonitorSmartphone}
      title="Signed-in devices"
      description={`You are currently signed in on ${activeSessions} device${activeSessions === 1 ? "" : "s"}.`}
    >
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="sign_out_others" />
        <Notice result={fetcher.data} intent="sign_out_others" />
        <button
          type="submit"
          disabled={busy || activeSessions <= 1}
          className="inline-flex items-center gap-2 border border-brand-navy/30 hover:border-brand-navy text-brand-navy disabled:opacity-50 text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <MonitorSmartphone size={15} />}
          Sign out other devices
        </button>
      </fetcher.Form>
    </Card>
  );
}
