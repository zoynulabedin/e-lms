import { data, redirect, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useState } from "react";
import { ShieldCheck, Mail, MonitorSmartphone } from "lucide-react";
import { prisma } from "../utils/db.server";
import {
  readPending,
  clearPendingCookie,
  verifyUserTotp,
  consumeRecoveryCode,
  consumeNewDeviceCode,
  issueNewDeviceCode,
  trustThisDevice,
} from "../utils/mfa.server";
import { sendNewDeviceCodeEmail } from "../utils/email.server";
import { rateLimitResponse, recordFailure, recordAttempt, TOO_MANY_ATTEMPTS } from "../utils/rate-limit.server";
import { finishSignIn, deviceLimitPayload, DeviceLimitError } from "../utils/sign-in.server";

/**
 * Second sign-in step, after a correct password (see utils/sign-in.server.ts):
 *   purpose "mfa"        → code from the authenticator app, or a recovery code
 *   purpose "new_device" → the 6-digit code emailed for an unknown browser
 * Wrong codes are counted per account (5 per 15 minutes); an emailed code dies
 * after 5 wrong tries or 10 minutes; an authenticator code works once.
 */

export const meta: MetaFunction = () => [{ title: "Confirm it's you" }];

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain ?? ""}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const pending = readPending(request);
  if (!pending || pending.purpose === "mfa_setup") throw redirect("/auth/login");
  const user = await prisma.user.findUnique({ where: { id: pending.userId }, select: { email: true } });
  if (!user) throw redirect("/auth/login");
  return { purpose: pending.purpose, maskedEmail: maskEmail(user.email) };
}

export async function action({ request }: ActionFunctionArgs) {
  const pending = readPending(request);
  if (!pending || pending.purpose === "mfa_setup") {
    return data({ error: "Your sign-in timed out. Please sign in again.", expired: true }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: pending.userId },
    select: { id: true, email: true, role: true, isBanned: true, isSuspended: true },
  });
  if (!user) return data({ error: "Your sign-in timed out. Please sign in again.", expired: true }, { status: 401 });

  const form = await request.formData();
  const intent = String(form.get("intent") || "verify");

  if (intent === "resend" && pending.purpose === "new_device") {
    const limited = rateLimitResponse("device_email", request, user.email);
    if (limited) return data({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
    recordAttempt("device_email", request, user.email);
    const code = await issueNewDeviceCode(user.id);
    const sent = await sendNewDeviceCodeEmail({ to: user.email, code });
    return data(sent.ok ? { info: "A new code is on its way." } : { error: "The email could not be sent. Please try again in a moment." });
  }

  const limited = rateLimitResponse("mfa_verify", request, user.id);
  if (limited) return data({ error: "Too many wrong codes. Please wait 15 minutes and try again." }, { status: 429 });

  const code = String(form.get("code") || "").trim();
  let ok = false;
  if (pending.purpose === "mfa") {
    ok = intent === "recovery" ? await consumeRecoveryCode(user.id, code) : await verifyUserTotp(user.id, code);
  } else {
    const r = await consumeNewDeviceCode(user.id, code);
    if (r === "expired") {
      recordFailure("mfa_verify", request, user.id);
      return data({ error: "That code has expired. Use \"Send a new code\" below." }, { status: 400 });
    }
    ok = r === "ok";
  }
  if (!ok) {
    recordFailure("mfa_verify", request, user.id);
    return data(
      { error: intent === "recovery" ? "That recovery code is not valid or was already used." : "That code is not correct." },
      { status: 400 },
    );
  }
  if (user.isBanned || user.isSuspended) {
    return data({ error: "This account is unavailable. Please contact support." }, { status: 403 });
  }

  // Passed: this browser is now known, so the next sign-in here needs no email code.
  const trusted = await trustThisDevice(request, user.id);
  try {
    return await finishSignIn(request, user, pending.redirectTo, [trusted, clearPendingCookie()]);
  } catch (e) {
    if (e instanceof DeviceLimitError) {
      return data(deviceLimitPayload(e, user.email), { status: 403, headers: { "Set-Cookie": clearPendingCookie() } });
    }
    throw e;
  }
}

export default function Verify() {
  const { purpose, maskedEmail } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as
    | { error?: string; info?: string; expired?: boolean; deviceLimit?: { email: string; devices: Array<{ label: string; lastActiveAt: string }> } }
    | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [useRecovery, setUseRecovery] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50">
            {purpose === "mfa" ? <ShieldCheck className="text-white w-7 h-7" /> : <Mail className="text-white w-7 h-7" />}
          </div>
          <h1 className="text-2xl font-bold text-white">Confirm it's you</h1>
          <p className="text-slate-300 mt-2 text-sm">
            {purpose === "mfa"
              ? useRecovery
                ? "Enter one of your recovery codes. Each code works once."
                : "Enter the 6-digit code from your authenticator app."
              : `This device is new to your account. We emailed a 6-digit code to ${maskedEmail}.`}
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl space-y-5">
          {result?.deviceLimit ? (
            <div role="alert" className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <p className="flex items-center gap-2 font-semibold"><MonitorSmartphone size={16} /> Device limit reached</p>
              <p className="mt-2">{result.error}</p>
              <ul className="mt-2 list-disc pl-5">
                {result.deviceLimit.devices.map((d, i) => (
                  <li key={i}>{d.label} (last active {new Date(d.lastActiveAt).toLocaleString()})</li>
                ))}
              </ul>
              <Form method="post" action="/auth/release-devices" reloadDocument className="mt-3">
                <input type="hidden" name="intent" value="request" />
                <input type="hidden" name="email" value={result.deviceLimit.email} />
                <button type="submit" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-brand-navy-deeper hover:bg-amber-400">
                  Email me a link to sign out my other devices
                </button>
              </Form>
            </div>
          ) : (
            <>
              {result?.error && (
                <div role="alert" className="bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg px-4 py-3 text-sm">
                  {result.error}
                  {result.expired && (
                    <Link to="/auth/login" className="block mt-1 font-medium text-brand-mustard">Sign in again</Link>
                  )}
                </div>
              )}
              {result?.info && (
                <div role="status" className="bg-green-500/10 border border-green-500/20 text-green-300 rounded-lg px-4 py-3 text-sm">{result.info}</div>
              )}
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value={useRecovery ? "recovery" : "verify"} />
                <label htmlFor="code" className="block text-sm font-medium text-slate-300">
                  {useRecovery ? "Recovery code" : "Code"}
                </label>
                <input
                  id="code"
                  name="code"
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode={useRecovery ? "text" : "numeric"}
                  maxLength={useRecovery ? 16 : 6}
                  placeholder={useRecovery ? "XXXXX-XXXXX" : "123456"}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white text-center text-xl tracking-[0.4em] placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-mustard"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg disabled:opacity-60"
                >
                  {busy ? "Checking…" : "Continue"}
                </button>
              </Form>
              <div className="flex items-center justify-between text-xs">
                {purpose === "mfa" ? (
                  <button type="button" onClick={() => setUseRecovery((v) => !v)} className="text-brand-mustard hover:underline">
                    {useRecovery ? "Use my authenticator app" : "Lost your phone? Use a recovery code"}
                  </button>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="resend" />
                    <button type="submit" disabled={busy} className="text-brand-mustard hover:underline">Send a new code</button>
                  </Form>
                )}
                <Link to="/auth/login" className="text-slate-400 hover:text-slate-200">Cancel</Link>
              </div>
              {purpose === "mfa" && (
                <p className="text-[11px] text-slate-500">
                  No phone and no recovery codes? Contact support: an administrator can reset two-step verification after confirming who you are.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
