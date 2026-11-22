import { useEffect, useState } from "react";
import { data, redirect, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import {
  requireUser,
  hashPassword,
  verifyPassword,
  getCurrentSessionTokenHash,
} from "../utils/auth.server";
import { sendEmailChangedNotice } from "../utils/email.server";
import {
  generateTotpSecret,
  encryptSecret,
  decryptSecret,
  otpauthUri,
  qrSvg,
  formatSecret,
  matchTotp,
  issueRecoveryCodes,
  verifyUserTotp,
  disableMfa,
} from "../utils/mfa.server";
import { rateLimitResponse, recordFailure, TOO_MANY_ATTEMPTS } from "../utils/rate-limit.server";
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
  ShieldCheck,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (user.role === "ADMIN") return redirect("/settings");

  const [completedCount, activeSessions, unusedRecovery] = await Promise.all([
    prisma.progress.count({
      where: { userId: user.id, completedAt: { not: null } },
    }),
    prisma.userSession.count({
      where: { userId: user.id, isActive: true, expiresAt: { gt: new Date() } },
    }),
    prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
  ]);

  return { user, hasCertificates: completedCount > 0, activeSessions, unusedRecovery };
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

    // Same test as the form uses to show the password field, so the server
    // never demands a password the form gave no field for.
    const oldEmail = user.email;
    if (email === oldEmail.trim().toLowerCase()) {
      await prisma.user.update({ where: { id: user.id }, data: { name } });
      return data({ intent, success: "Profile updated." });
    }

    // Whoever controls the email can reset the password. Without this check,
    // anyone at an unattended signed-in browser could point the account at
    // their own address and take it over for good. Checked before the "email
    // taken" lookup so the form can't be used to probe which addresses exist.
    // Rate-limited per account, or that same browser could guess the password.
    // The 429 carries the intent so this card shows it.
    if (rateLimitResponse("account_password", request, user.id)) {
      return data({ intent, error: TOO_MANY_ATTEMPTS }, { status: 429 });
    }
    const current = String(formData.get("currentPassword") || "");
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!current || !row || !(await verifyPassword(current, row.passwordHash))) {
      recordFailure("account_password", request, user.id);
      return data({ intent, error: "Enter your current password to change your email." }, { status: 401 });
    }

    const conflict = await prisma.user.findFirst({
      where: { email, NOT: { id: user.id } },
      select: { id: true },
    });
    if (conflict) {
      return data({ intent, error: "That email is already used by another account." }, { status: 409 });
    }

    const keep = getCurrentSessionTokenHash(request);
    try {
      // Switch the address, kill any reset link already mailed to the old one,
      // and sign out every OTHER device; this session stays.
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { name, email } }),
        prisma.passwordReset.deleteMany({ where: { userId: user.id } }),
        prisma.userSession.updateMany({
          where: { userId: user.id, isActive: true, ...(keep ? { token: { not: keep } } : {}) },
          data: { isActive: false },
        }),
      ]);
    } catch (e: any) {
      // Another account took the address between the check above and the update.
      if (e?.code === "P2002") {
        return data({ intent, error: "That email is already used by another account." }, { status: 409 });
      }
      throw e;
    }

    // Tell the OLD address, so a change the owner didn't make can't go
    // unnoticed. Not awaited: the change is already saved, and a slow or
    // failing mail provider must not hold up or fail this response.
    void sendEmailChangedNotice({ to: oldEmail, newEmail: email })
      .then((r) => {
        if (!r.ok) console.error(`[settings] email-changed notice for user ${user.id} failed: ${r.error}`);
      })
      .catch(console.error);

    return data({
      intent,
      success: "Profile updated. We sent a notice to your previous email address and signed out your other devices.",
    });
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
    // Same budget as the email change above: wrong guesses here count too.
    if (rateLimitResponse("account_password", request, user.id)) {
      return data({ intent, error: TOO_MANY_ATTEMPTS }, { status: 429 });
    }
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row || !(await verifyPassword(current, row.passwordHash))) {
      recordFailure("account_password", request, user.id);
      return data({ intent, error: "Current password is incorrect." }, { status: 401 });
    }

    const passwordHash = await hashPassword(next);
    const keep = getCurrentSessionTokenHash(request);
    // Set the new password, void any outstanding reset link (it would still let
    // someone set a password of their own), and sign out every OTHER device;
    // this session stays.
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.passwordReset.deleteMany({ where: { userId: user.id } }),
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

  // ── Two-step verification (optional for learners) ─────────────────────────
  if (intent === "mfa_start") {
    if (user.mfaEnabled) return data({ intent, error: "Two-step verification is already on." }, { status: 400 });
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: encryptSecret(secret), mfaLastStep: null } });
    return data({ intent, qr: await qrSvg(otpauthUri(secret, user.email)), manualKey: formatSecret(secret) });
  }
  if (intent === "mfa_confirm") {
    if (rateLimitResponse("mfa_verify", request, user.id)) return data({ intent, error: TOO_MANY_ATTEMPTS }, { status: 429 });
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { mfaSecret: true, mfaEnabledAt: true } });
    const secret = row?.mfaSecret ? decryptSecret(row.mfaSecret) : null;
    if (!secret || row?.mfaEnabledAt) return data({ intent, error: "Start again: click Turn on." }, { status: 400 });
    const step = matchTotp(secret, String(formData.get("code") || ""), null);
    if (step === null) {
      recordFailure("mfa_verify", request, user.id);
      return data({ intent, error: "That code is not correct. Try the newest code from the app." }, { status: 400 });
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date(), mfaLastStep: step } });
    return data({ intent, success: "Two-step verification is on.", codes: await issueRecoveryCodes(user.id) });
  }
  if (intent === "mfa_codes") {
    if (rateLimitResponse("mfa_verify", request, user.id)) return data({ intent, error: TOO_MANY_ATTEMPTS }, { status: 429 });
    if (!(await verifyUserTotp(user.id, String(formData.get("code") || "")))) {
      recordFailure("mfa_verify", request, user.id);
      return data({ intent, error: "That code is not correct." }, { status: 400 });
    }
    return data({ intent, success: "New recovery codes created. The old ones no longer work.", codes: await issueRecoveryCodes(user.id) });
  }
  if (intent === "mfa_disable") {
    if (rateLimitResponse("account_password", request, user.id)) return data({ intent, error: TOO_MANY_ATTEMPTS }, { status: 429 });
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    const passwordOk = row ? await verifyPassword(String(formData.get("password") || ""), row.passwordHash) : false;
    const codeOk = passwordOk && (await verifyUserTotp(user.id, String(formData.get("code") || "")));
    if (!passwordOk || !codeOk) {
      recordFailure("account_password", request, user.id);
      return data({ intent, error: "Password or code is not correct." }, { status: 400 });
    }
    await disableMfa(user.id);
    return data({ intent, success: "Two-step verification is off." });
  }

  return data({ intent, error: "Unknown action." }, { status: 400 });
}

type ActionResult = { intent: string; error?: string; success?: string };

export default function StudentSettings() {
  const { user, hasCertificates, activeSessions, unusedRecovery } = useLoaderData<typeof loader>();

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
            <TwoStepCard enabled={user.mfaEnabled} unusedRecovery={unusedRecovery} />
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
  // Tracked so the form knows when the email is being changed: that needs the
  // current password (the action applies the same comparison).
  const [email, setEmail] = useState(user.email);
  // After a successful change the loader revalidates with the saved address;
  // adopt it so the input shows what was stored and the password field closes.
  useEffect(() => { setEmail(user.email); }, [user.email]);
  const emailChanged = email.trim().toLowerCase() !== user.email.trim().toLowerCase();

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
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputCls}
            />
          </div>
          {emailChanged && (
            // Sits under the Email column; unmounting it when the email is put
            // back (or saved) also clears whatever was typed into it.
            <div className="sm:col-start-2">
              <label htmlFor="profileCurrentPassword" className={labelCls}>Current password</label>
              <input
                id="profileCurrentPassword"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                aria-describedby="profileCurrentPasswordHint"
                className={inputCls}
              />
              <p id="profileCurrentPasswordHint" className="text-xs text-brand-navy/55 mt-1.5">
                Required to change your email.
              </p>
            </div>
          )}
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

// ── Two-step verification ───────────────────────────────────────────────────

type MfaResult = ActionResult & { qr?: string; manualKey?: string; codes?: string[] };

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-lg border border-brand-beige-dark bg-brand-beige/50 p-4">
      <p className="text-sm font-semibold text-brand-navy">Your recovery codes</p>
      <p className="text-xs text-brand-navy/60 mt-0.5">
        Each works once if you lose your phone. Save them somewhere safe - they are shown only now.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-brand-navy">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </div>
  );
}

function TwoStepCard({ enabled, unusedRecovery }: { enabled: boolean; unusedRecovery: number }) {
  const fetcher = useFetcher<MfaResult>();
  const busy = fetcher.state !== "idle";
  const r = fetcher.data;
  const setup = r?.intent === "mfa_start" && r.qr ? r : null;
  const confirmed = r?.intent === "mfa_confirm" && r.codes;
  const isOn = enabled || !!confirmed;

  return (
    <Card
      icon={ShieldCheck}
      title="Two-step verification"
      description={
        isOn
          ? `On. Signing in asks for a code from your authenticator app. ${unusedRecovery} recovery code${unusedRecovery === 1 ? "" : "s"} left.`
          : "Off. Turn it on to require a code from an authenticator app (on your phone) when you sign in."
      }
    >
      <div className="space-y-4">
        {r && ["mfa_start", "mfa_confirm", "mfa_codes", "mfa_disable"].includes(r.intent) && <Notice result={r} intent={r.intent} />}
        {r?.codes && <RecoveryCodes codes={r.codes} />}

        {!isOn && !setup && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="mfa_start" />
            <button type="submit" disabled={busy} className={buttonCls}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Turn on
            </button>
          </fetcher.Form>
        )}

        {!isOn && setup && (
          <div className="space-y-3">
            <p className="text-sm text-brand-navy/80">Scan this with Google Authenticator (or another authenticator app), or type the key, then enter the 6-digit code it shows.</p>
            <div className="flex flex-wrap items-center gap-4">
              <div className="bg-white border border-brand-beige-dark p-2 rounded-lg w-[200px] h-[200px]" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: setup.qr ?? "" }} />
              <p className="text-xs text-brand-navy/60">Key:<br /><span className="font-mono text-brand-navy select-all">{setup.manualKey}</span></p>
            </div>
            <fetcher.Form method="post" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="mfa_confirm" />
              <label className={labelCls}>
                Code
                <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" className={`${inputCls} w-40 tracking-[0.3em]`} />
              </label>
              <button type="submit" disabled={busy} className={buttonCls}>Confirm</button>
            </fetcher.Form>
          </div>
        )}

        {isOn && (
          <div className="grid gap-4 sm:grid-cols-2">
            <fetcher.Form method="post" className="space-y-2">
              <input type="hidden" name="intent" value="mfa_codes" />
              <label className={labelCls}>
                New recovery codes
                <input name="code" required inputMode="numeric" maxLength={6} placeholder="Google Authenticator code" className={inputCls} />
              </label>
              <button type="submit" disabled={busy} className={buttonCls}>Create new codes</button>
            </fetcher.Form>
            <fetcher.Form method="post" className="space-y-2">
              <input type="hidden" name="intent" value="mfa_disable" />
              <label className={labelCls}>
                Turn off
                <input name="password" type="password" required placeholder="Your password" autoComplete="current-password" className={inputCls} />
              </label>
              <input name="code" required inputMode="numeric" maxLength={6} placeholder="Google Authenticator code" aria-label="Google Authenticator code" className={inputCls} />
              <button type="submit" disabled={busy} className="inline-flex items-center gap-2 border border-red-300 text-red-700 hover:bg-red-50 text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                Turn off two-step verification
              </button>
            </fetcher.Form>
          </div>
        )}
      </div>
    </Card>
  );
}
