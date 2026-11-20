import { redirect } from "react-router";
import { createSession, createSessionCookie, DeviceLimitError } from "./auth.server";
import {
  createPendingCookie,
  isTrustedDevice,
  issueNewDeviceCode,
  newDeviceCheckEnabled,
  type PendingPurpose,
} from "./mfa.server";
import { sendNewDeviceCodeEmail } from "./email.server";

/**
 * The steps every sign-in goes through after a correct password, in one place
 * so the login page, the redeem page and the second-step pages can't drift:
 *
 *   authenticator set up         → enter its code (or a recovery code)
 *   ADMIN without authenticator  → set one up first (admins always need it)
 *   unknown browser (learners)   → enter the code emailed to the account
 *   then                         → session, unless the device limit is reached
 */

export type SignInUser = { id: string; email: string; role: string; mfaEnabledAt: Date | null };

/** Where a role lands after signing in. */
export function landingFor(role: string): string {
  if (role === "ADMIN") return "/";
  if (role === "CORPORATE") return "/org";
  return "/student";
}

/** The second step this sign-in still needs, or null. */
export async function secondStepFor(request: Request, user: SignInUser): Promise<PendingPurpose | null> {
  if (user.mfaEnabledAt) return "mfa";
  if (user.role === "ADMIN") return "mfa_setup";
  if (newDeviceCheckEnabled() && !(await isTrustedDevice(request, user.id))) return "new_device";
  return null;
}

/** Sends the browser to its second step (and emails the code for a new device). */
export async function beginSecondStep(user: SignInUser, purpose: PendingPurpose, redirectTo: string): Promise<Response> {
  if (purpose === "new_device") {
    const code = await issueNewDeviceCode(user.id);
    const sent = await sendNewDeviceCodeEmail({ to: user.email, code });
    if (!sent.ok) console.error(`[sign-in] new-device code for ${user.email} not sent: ${sent.error}`);
  }
  const headers = new Headers();
  headers.append("Set-Cookie", createPendingCookie({ userId: user.id, purpose, redirectTo }));
  return redirect(purpose === "mfa_setup" ? "/auth/mfa-setup" : "/auth/verify", { headers });
}

/** Creates the session and redirects. Throws DeviceLimitError at the device limit. */
export async function finishSignIn(
  request: Request,
  user: { id: string; role: string },
  redirectTo: string,
  extraCookies: string[] = [],
): Promise<Response> {
  const token = await createSession(user.id, user.role, request);
  const headers = new Headers();
  headers.append("Set-Cookie", createSessionCookie(token));
  for (const c of extraCookies) headers.append("Set-Cookie", c);
  return redirect(redirectTo || landingFor(user.role), { headers });
}

/** What the sign-in pages show when the device limit refuses a sign-in. */
export function deviceLimitPayload(err: DeviceLimitError, email: string) {
  return {
    error:
      `You're already signed in on ${err.limit} device${err.limit === 1 ? "" : "s"}, the most this account can use. ` +
      "Sign out on one of them, or use the button below to get an email link that signs them all out.",
    deviceLimit: { email, devices: err.devices },
  };
}

export { DeviceLimitError };
