import { data, redirect, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { ShieldCheck, KeyRound } from "lucide-react";
import { prisma } from "../utils/db.server";
import { getSessionUser, createSession, createSessionCookie, DeviceLimitError } from "../utils/auth.server";
import {
  readPending,
  clearPendingCookie,
  generateTotpSecret,
  encryptSecret,
  decryptSecret,
  otpauthUri,
  qrSvg,
  formatSecret,
  matchTotp,
  issueRecoveryCodes,
  trustThisDevice,
} from "../utils/mfa.server";
import { rateLimitResponse, recordFailure } from "../utils/rate-limit.server";
import { landingFor } from "../utils/sign-in.server";

/**
 * Authenticator set-up. Reached
 *  - during sign-in by an admin without one (pending sign-in "mfa_setup"):
 *    admins are never let in on a password alone; or
 *  - by a signed-in account without one (requireAdmin sends admins here).
 * Learners turn it on from their Settings page instead.
 */

export const meta: MetaFunction = () => [{ title: "Set up two-step verification" }];

// After a successful set-up the loader would redirect away (MFA is now on)
// before the one-time recovery codes are ever shown, so it doesn't re-run.
export function shouldRevalidate({
  actionResult,
  defaultShouldRevalidate,
}: {
  actionResult?: unknown;
  defaultShouldRevalidate: boolean;
}) {
  if (actionResult && typeof actionResult === "object" && "codes" in actionResult) return false;
  return defaultShouldRevalidate;
}

async function whoIsSettingUp(request: Request) {
  const pending = readPending(request);
  if (pending?.purpose === "mfa_setup") return { userId: pending.userId, mode: "pending" as const, next: pending.redirectTo };
  const session = await getSessionUser(request);
  if (!session) return null;
  return { userId: session.id, mode: "session" as const, next: "" };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const who = await whoIsSettingUp(request);
  if (!who) throw redirect("/auth/login");
  const user = await prisma.user.findUnique({
    where: { id: who.userId },
    select: { email: true, role: true, mfaSecret: true, mfaEnabledAt: true },
  });
  if (!user) throw redirect("/auth/login");
  if (user.mfaEnabledAt) throw redirect(landingFor(user.role));

  // Keep a secret that was generated but not confirmed yet, so reloading the
  // page doesn't invalidate a QR code already scanned.
  let secret = user.mfaSecret ? decryptSecret(user.mfaSecret) : null;
  if (!secret) {
    secret = generateTotpSecret();
    await prisma.user.update({ where: { id: who.userId }, data: { mfaSecret: encryptSecret(secret), mfaLastStep: null } });
  }
  return {
    email: user.email,
    isAdmin: user.role === "ADMIN",
    qr: await qrSvg(otpauthUri(secret, user.email)),
    manualKey: formatSecret(secret),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const who = await whoIsSettingUp(request);
  if (!who) return data({ error: "Your sign-in timed out. Please sign in again." }, { status: 401 });
  const limited = rateLimitResponse("mfa_verify", request, who.userId);
  if (limited) return data({ error: "Too many wrong codes. Please wait 15 minutes and try again." }, { status: 429 });

  const user = await prisma.user.findUnique({
    where: { id: who.userId },
    select: { id: true, email: true, role: true, mfaSecret: true, mfaEnabledAt: true },
  });
  const secret = user?.mfaSecret ? decryptSecret(user.mfaSecret) : null;
  if (!user || !secret) return data({ error: "Set-up expired. Reload the page and scan the new code." }, { status: 400 });
  if (user.mfaEnabledAt) return redirect(landingFor(user.role));

  const form = await request.formData();
  const step = matchTotp(secret, String(form.get("code") || ""), null);
  if (step === null) {
    recordFailure("mfa_verify", request, user.id);
    return data({ error: "That code is not correct. Check the time on your phone is set automatically, then try the newest code." }, { status: 400 });
  }
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date(), mfaLastStep: step } });
  const codes = await issueRecoveryCodes(user.id);
  console.warn(`[mfa] two-step verification turned on for ${user.email}`);

  const next = who.next || `${landingFor(user.role)}${user.role === "ADMIN" ? "?toast=welcome" : ""}`;
  if (who.mode === "session") return data({ codes, next });

  // Finishing a sign-in: the session starts now; the codes are shown first.
  const headers = new Headers();
  headers.append("Set-Cookie", clearPendingCookie());
  headers.append("Set-Cookie", await trustThisDevice(request, user.id));
  try {
    headers.append("Set-Cookie", createSessionCookie(await createSession(user.id, user.role, request)));
    return data({ codes, next }, { headers });
  } catch (e) {
    if (e instanceof DeviceLimitError) {
      return data(
        {
          codes,
          next: "/auth/login",
          warning: `Two-step verification is on, but this account is already signed in on ${e.limit} device(s). Sign out on one of them, then sign in again.`,
        },
        { headers },
      );
    }
    throw e;
  }
}

export default function MfaSetup() {
  const { email, isAdmin, qr, manualKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as { error?: string; codes?: string[]; next?: string; warning?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50">
            <ShieldCheck className="text-white w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white">Set up two-step verification</h1>
          <p className="text-slate-300 mt-2 text-sm">
            {isAdmin
              ? "Administrator accounts must use an authenticator app in addition to the password."
              : "Protect your account with an authenticator app."}{" "}
            <span className="text-slate-400">({email})</span>
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl space-y-5 text-slate-200">
          {result?.codes ? (
            <>
              <p className="flex items-center gap-2 font-semibold text-white"><KeyRound size={17} /> Save your recovery codes</p>
              <p className="text-sm text-slate-300">
                If you lose your phone, each of these codes lets you sign in once. Store them somewhere safe - they are shown only now.
              </p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-black/30 rounded-lg p-4">
                {result.codes.map((c) => <li key={c}>{c}</li>)}
              </ul>
              {result.warning && <p className="text-sm text-amber-300">{result.warning}</p>}
              <Link to={result.next ?? "/"} className="block w-full text-center bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg">
                I've saved them - continue
              </Link>
            </>
          ) : (
            <>
              <ol className="text-sm space-y-1 list-decimal pl-5 text-slate-300">
                <li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
                <li>Scan this QR code with it, or type the key below.</li>
                <li>Enter the 6-digit code the app shows.</li>
              </ol>
              <div className="flex flex-col items-center gap-3">
                <div className="bg-white p-2 rounded-lg w-[200px] h-[200px]" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: qr }} />
                <p className="text-xs text-slate-400">Key: <span data-testid="mfa-key" className="font-mono text-slate-200 select-all">{manualKey}</span></p>
              </div>
              {result?.error && (
                <div role="alert" className="bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg px-4 py-3 text-sm">{result.error}</div>
              )}
              <Form method="post" className="space-y-3">
                <input
                  name="code"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  aria-label="6-digit code"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white text-center text-xl tracking-[0.4em] placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-mustard"
                />
                <button type="submit" disabled={busy} className="w-full bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg disabled:opacity-60">
                  {busy ? "Checking…" : "Turn on two-step verification"}
                </button>
              </Form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
