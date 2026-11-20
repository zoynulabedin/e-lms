import { data, redirect, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { MonitorSmartphone, MailCheck } from "lucide-react";
import { prisma } from "../utils/db.server";
import { issueReleaseToken, peekReleaseToken, RELEASE_MINUTES } from "../utils/mfa.server";
import { sendReleaseDevicesEmail } from "../utils/email.server";
import { rateLimitResponse, recordAttempt, TOO_MANY_ATTEMPTS } from "../utils/rate-limit.server";

/**
 * Device limit reached: the learner asks for an emailed link that signs out
 * every device on the account. Opening the link and confirming ends all
 * sessions; the learner then signs in normally on the device they want (so the
 * password, two-step verification and new-device checks all still apply - this
 * link never signs anyone in). An admin can do the same from Sessions / Users.
 */

export const meta: MetaFunction = () => [{ title: "Sign out your other devices" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") || "";
  // The link lifetime goes to the page as data: mfa.server is server-only.
  if (!token) return { mode: "request" as const, valid: false, token: "", releaseMinutes: RELEASE_MINUTES };
  return { mode: "confirm" as const, valid: !!(await peekReleaseToken(token)), token, releaseMinutes: RELEASE_MINUTES };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "request") {
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!email) return data({ error: "Enter your email address." }, { status: 400 });
    const limited = rateLimitResponse("device_email", request, email);
    if (limited) return data({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
    recordAttempt("device_email", request, email);
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    // Same answer whether or not the account exists (no account discovery).
    if (user) {
      const token = await issueReleaseToken(user.id);
      const sent = await sendReleaseDevicesEmail({ to: email, token });
      if (!sent.ok) console.error(`[release-devices] email to ${email} failed: ${sent.error}`);
    }
    return data({ sent: true });
  }

  if (intent === "confirm") {
    const token = String(form.get("token") || "");
    const found = await peekReleaseToken(token);
    if (!found) return data({ error: "This link has expired or was already used." }, { status: 400 });
    const done = await prisma.$transaction(async (tx) => {
      const used = await tx.authToken.updateMany({ where: { id: found.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count === 0) return false;
      await tx.userSession.updateMany({ where: { userId: found.userId, isActive: true }, data: { isActive: false } });
      return true;
    });
    if (!done) return data({ error: "This link has expired or was already used." }, { status: 400 });
    console.warn(`[release-devices] all sessions of user ${found.userId} ended via emailed link`);
    return redirect("/auth/login?released=1");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function ReleaseDevices() {
  const { mode, valid, token, releaseMinutes } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as { sent?: boolean; error?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50">
            {result?.sent ? <MailCheck className="text-white w-7 h-7" /> : <MonitorSmartphone className="text-white w-7 h-7" />}
          </div>
          <h1 className="text-2xl font-bold text-white">Sign out your other devices</h1>
        </div>
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl space-y-4 text-slate-200 text-sm">
          {result?.error && <div role="alert" className="bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg px-4 py-3">{result.error}</div>}
          {result?.sent ? (
            <p>
              If that email belongs to an account, a link is on its way. It works once and expires in {releaseMinutes} minutes.
              Open it on any device, confirm, then sign in here.
            </p>
          ) : mode === "confirm" ? (
            valid ? (
              <>
                <p>This signs your account out on <strong>every</strong> device. You can then sign in on the device you want to use.</p>
                <Form method="post">
                  <input type="hidden" name="intent" value="confirm" />
                  <input type="hidden" name="token" value={token} />
                  <button type="submit" disabled={busy} className="w-full bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg disabled:opacity-60">
                    Sign out all my devices
                  </button>
                </Form>
              </>
            ) : (
              <p className="text-red-300">This link has expired or was already used. Ask for a new one from the sign-in page.</p>
            )
          ) : (
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="request" />
              <label className="block text-slate-300">
                Email address
                <input name="email" type="email" required className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-brand-mustard" />
              </label>
              <button type="submit" disabled={busy} className="w-full bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg disabled:opacity-60">
                Email me the link
              </button>
            </Form>
          )}
          <Link to="/auth/login" className="block text-center text-slate-400 hover:text-slate-200">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
