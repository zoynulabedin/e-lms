import { redirect, data } from "react-router";
import {
  Form,
  Link,
  useLoaderData,
  useActionData,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import {
  getSessionUser,
  hashPassword,
  verifyPassword,
  createSession,
  createSessionCookie,
} from "../utils/auth.server";
import { trustThisDevice } from "../utils/mfa.server";
import {
  secondStepFor,
  beginSecondStep,
  deviceLimitPayload,
  DeviceLimitError,
  type SignInUser,
} from "../utils/sign-in.server";
import { Key, CheckCircle2, AlertCircle, BookOpen, ShieldAlert, Info } from "lucide-react";
import { rateLimitResponse, recordFailure } from "../utils/rate-limit.server";
import { emailDomainError, emailFormatError, nameError, normalizeName, passwordError } from "../utils/registration.server";
import { isPlaceholderEmail, normalizeLicenseKey } from "../utils/license";
import {
  resolveLicenseKey,
  lockUserAndFindActiveLicense,
  ensureEnrollment,
} from "../utils/license.server";
import { useState } from "react";

const TOO_MANY_ATTEMPTS = "Too many attempts. Please wait a few minutes and try again.";
const ACCOUNT_EXISTS =
  "An account with this email already exists. Enter its password, or sign in first and redeem from your dashboard.";

/**
 * Everything the page renders and nothing more. Anyone holding a key gets
 * this without signing in, so the licence and course rows (buyer email, order
 * id, embed / video URLs...) are never sent whole.
 */
type RedeemPage = {
  /** The STORED key once found; otherwise what was typed, normalised. */
  key: string;
  /** null = no key yet, not found, or the lookup was rate-limited. */
  status: "PENDING" | "ACTIVE" | "REVOKED" | null;
  courseTitle: string | null;
  /** Pre-fills the account form; "" unless the key is unused and names its buyer. */
  prefillEmail: string;
  user: { email: string; role: string } | null;
  error?: string;
};

/** "a***@school.org": enough for the invitee to recognise, without exposing the address to whoever holds the link. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain ?? ""}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Keys are typed from paper: spaces, missing dashes, lowercase and a missing
  // LIC prefix all reduce to the canonical form (same as the action).
  const input = normalizeLicenseKey(url.searchParams.get("key"));
  const page: RedeemPage = {
    key: input,
    status: null,
    courseTitle: null,
    prefillEmail: "",
    user: null,
  };
  if (!input) return page;

  // Per IP only (a no-op when the IP is unknown): a guesser changes the key on
  // every try, so a per-key bucket would never fill. Its own generous bucket,
  // so a classroom's typos on this page can't block redeeming (the action's
  // stricter "redeem" bucket is separate).
  if (rateLimitResponse("redeem_lookup", request)) {
    const limitedPage: RedeemPage = { ...page, error: TOO_MANY_ATTEMPTS };
    return data(limitedPage, { status: 429 });
  }

  const storedKey = await resolveLicenseKey(input);
  const license = storedKey
    ? await prisma.license.findUnique({
        where: { key: storedKey },
        select: {
          key: true,
          status: true,
          customerEmail: true,
          isBulk: true,
          assignedEmail: true,
          course: { select: { title: true } },
        },
      })
    : null;
  if (!license) {
    recordFailure("redeem_lookup", request);
    return page;
  }

  const sessionUser = await getSessionUser(request);
  const found: RedeemPage = {
    key: license.key,
    status: license.status,
    courseTitle: license.course.title,
    // An organization invitation names its learner; a bulk key's email is
    // whoever ordered the batch, not the person redeeming.
    prefillEmail:
      license.status !== "PENDING"
        ? ""
        : license.assignedEmail
          ? license.assignedEmail
          : !license.isBulk && !isPlaceholderEmail(license.customerEmail)
            ? license.customerEmail
            : "",
    user: sessionUser ? { email: sessionUser.email, role: sessionUser.role } : null,
  };
  return found;
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const input = normalizeLicenseKey(formData.get("key"));
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") || "");
  const intent = String(formData.get("intent") || "");

  if (!input) return data({ error: "License key is required." }, { status: 400 });
  const limited = rateLimitResponse("redeem", request, input);
  if (limited) return limited;

  // From here on only the STORED key is used (a typed O/0 or I/1 slip resolves to it).
  const storedKey = await resolveLicenseKey(input);
  const license = storedKey
    ? await prisma.license.findUnique({
        where: { key: storedKey },
        select: {
          id: true,
          key: true,
          status: true,
          customerEmail: true,
          shopifyOrderId: true,
          courseId: true,
          assignedEmail: true,
          course: { select: { title: true } },
        },
      })
    : null;

  if (!license) {
    recordFailure("redeem", request, input);
    return data({ error: "Invalid license key." }, { status: 404 });
  }
  if (license.status === "REVOKED")
    return data({ error: "This license has been revoked." }, { status: 403 });
  if (license.status === "ACTIVE")
    return data(
      { error: "This license key has already been redeemed." },
      { status: 409 },
    );

  // An organization invitation is bound to the invited email address: a
  // forwarded link can't be used to take the seat with another account.
  const invitedTo = license.assignedEmail?.toLowerCase() ?? null;
  const notInvited = (who: string) =>
    invitedTo && who.toLowerCase() !== invitedTo
      ? data(
          {
            error:
              `This invitation is for ${maskEmail(invitedTo)}. Sign in or create your account with that email address, ` +
              "or ask your organization to invite the address you use.",
          },
          { status: 403 },
        )
      : null;

  // ─── Get or create user ───────────────────────────────────────────────────
  let userId: string;
  let userEmail: string = email;
  // Set when this form signed the visitor in with an email + password: the
  // session is only started after the key is activated, and an existing
  // account still goes through its second step (authenticator / new device).
  let signIn: { user: SignInUser; isNew: boolean } | null = null;

  if (intent === "redeem_existing") {
    // User is already logged in
    const sessionUser = await getSessionUser(request);
    if (!sessionUser)
      return redirect(
        `/auth/login?redirect=${encodeURIComponent(`/redeem?key=${encodeURIComponent(license.key)}`)}`,
      );
    // An admin opening a customer's link must not spend the key with one click.
    if (sessionUser.role === "ADMIN" && formData.get("confirmAdmin") !== "1") {
      return data(
        {
          error: `You're signed in as an admin, so this key would be used up for your admin account and the customer couldn't use it. Tick "Use this key for my admin account" to go ahead, or sign out first.`,
        },
        { status: 400 },
      );
    }
    const wrongInvitee = notInvited(sessionUser.email);
    if (wrongInvitee) return wrongInvitee;
    userId = sessionUser.id;
    userEmail = sessionUser.email;
  } else {
    // Register a new account on redeem
    if (!name || !email || password.length < 8) {
      return data(
        {
          error:
            "Name, email, and a password of at least 8 characters are required.",
        },
        { status: 400 },
      );
    }
    const wrongInvitee = notInvited(email);
    if (wrongInvitee) return wrongInvitee;
    // Second subject: the account email - one PENDING key must not become an
    // unlimited password oracle for an existing account.
    const limitedByEmail = rateLimitResponse("redeem", request, email);
    if (limitedByEmail) return limitedByEmail;

    const accountFields = {
      id: true,
      role: true,
      passwordHash: true,
      isBanned: true,
      isSuspended: true,
      mfaEnabledAt: true,
    } as const;
    let user = await prisma.user.findUnique({ where: { email }, select: accountFields });
    const isNew = !user;
    if (!user) {
      // A new account gets the same name / email / password checks as
      // /auth/register. No emailed code here: the key itself proves a purchase.
      const cleanName = normalizeName(name);
      const problem =
        nameError(cleanName) ??
        emailFormatError(email) ??
        passwordError(password, { email, name: cleanName }) ??
        (await emailDomainError(email));
      if (problem) return data({ error: problem }, { status: 400 });
      const passwordHash = await hashPassword(password);
      try {
        user = await prisma.user.create({
          data: { name: cleanName, email, passwordHash, role: "STUDENT" },
          select: accountFields,
        });
      } catch (e: any) {
        // Created a moment ago by a parallel submit with the same email.
        if (e?.code === "P2002") return data({ error: ACCOUNT_EXISTS }, { status: 409 });
        throw e;
      }
    } else {
      // Existing account: never issue a session without verifying the password.
      // The password is checked BEFORE the ban flags, so a valid key plus a
      // guessed password can't reveal that an account is banned or suspended.
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        recordFailure("redeem", request, email);
        return data({ error: ACCOUNT_EXISTS }, { status: 401 });
      }
      if (user.isBanned || user.isSuspended) {
        return data(
          { error: "This account is unavailable. Please contact support." },
          { status: 403 },
        );
      }
    }
    userId = user.id;
    signIn = { user: { id: user.id, email, role: user.role, mfaEnabledAt: user.mfaEnabledAt }, isNew };
  }

  // Activate license atomically: the conditional updateMany is the lock -
  // two people submitting the same key at once can't both win, and a failure
  // after the flip can't leave an ACTIVE key without an enrolment.
  // An unaddressed ADMIN key takes the redeemer's address, so the list and
  // "Resend Email" have a real one. A Shopify key's address belongs to the
  // order: when the order had none it stays the placeholder, so a later
  // Release Seat / "Resend Email" never treats this learner as the buyer.
  const redeemedEmail =
    !license.shopifyOrderId && isPlaceholderEmail(license.customerEmail) ? userEmail || null : null;
  const outcome = await prisma.$transaction(async (tx) => {
    // Already holds the course (e.g. a 3-seat buyer clicking the second email
    // link while signed in): leave this key PENDING so the seat isn't lost.
    // The user-row lock also stops two keys for one course landing at once.
    if (await lockUserAndFindActiveLicense(tx, userId, license.courseId, license.id)) {
      return "has_course" as const;
    }
    const r = await tx.license.updateMany({
      where: { key: license.key, status: "PENDING" },
      data: {
        status: "ACTIVE",
        userId,
        redeemedAt: new Date(),
        ...(redeemedEmail ? { customerEmail: redeemedEmail } : {}),
      },
    });
    if (r.count === 0) return "taken" as const;
    await ensureEnrollment(tx, userId, license.courseId);
    return "activated" as const;
  });

  const target = `/student/course/${license.courseId}`;
  const notActivated = () =>
    outcome === "has_course"
      ? {
          error: `You're already enrolled in ${license.course.title}. Your course is available in your learning dashboard.`,
          courseId: license.courseId,
          alreadyHave: true,
        }
      : { error: "This license key has already been redeemed." };

  const responseHeaders = new Headers();
  if (signIn) {
    // An existing account: its authenticator / new-device step comes first,
    // then the learner lands in the course.
    if (!signIn.isNew) {
      const step = await secondStepFor(request, signIn.user);
      if (step) {
        if (outcome !== "activated") return data(notActivated(), { status: 409 });
        return beginSecondStep(signIn.user, step, target);
      }
    }
    try {
      responseHeaders.append("Set-Cookie", createSessionCookie(await createSession(signIn.user.id, signIn.user.role, request)));
      // A brand-new account was just made in this browser: it is a known device.
      if (signIn.isNew) responseHeaders.append("Set-Cookie", await trustThisDevice(request, signIn.user.id));
    } catch (e) {
      if (e instanceof DeviceLimitError) {
        const p = deviceLimitPayload(e, signIn.user.email);
        return data(
          { ...p, error: outcome === "activated" ? `The course was added to your account. ${p.error}` : p.error },
          { status: 403 },
        );
      }
      throw e;
    }
  }

  if (outcome !== "activated") {
    return data(notActivated(), { status: 409, headers: responseHeaders });
  }
  return redirect(target, { headers: responseHeaders });
}

export default function Redeem() {
  const { key, status, courseTitle, prefillEmail, user, error: loaderError } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set when the account already holds this course: offer the way in. (The
  // inferred action type folds { error, courseId } into { error }, hence typeof.)
  const ownedCourseId =
    actionData && "courseId" in actionData && typeof actionData.courseId === "string"
      ? actionData.courseId
      : null;
  const isAdmin = user?.role === "ADMIN";
  // Device limit reached while signing in here: offer the emailed release link.
  const deviceLimitEmail =
    actionData && "deviceLimit" in actionData ? ((actionData.deviceLimit as { email?: string } | undefined)?.email ?? null) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50">
            <Key className="text-white w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white">Redeem Your License</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Enter your license key to unlock your course
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {/* Already enrolled: the "You Already Have Access!" notice from the
              client's acceptance document, with the way into the dashboard. */}
          {actionData?.error && ownedCourseId && (
            <div role="status" className="rounded-xl border border-white/15 bg-black/60 px-5 py-4 mb-5">
              <p className="flex items-center gap-2 font-semibold text-white">
                <Info size={17} className="shrink-0 text-sky-400" /> You Already Have Access!
              </p>
              <p className="text-sm text-white/85 mt-2">{actionData.error}</p>
              <Link
                to="/student"
                className="mt-4 flex w-full items-center justify-center rounded-full bg-white/90 hover:bg-white text-brand-navy-deeper text-sm font-semibold py-2.5"
              >
                Go to My Dashboard
              </Link>
              <p className="text-xs text-white/50 mt-3">This key was not used - you can give it to someone else.</p>
            </div>
          )}
          {actionData?.error && !ownedCourseId && (
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm mb-5">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <div>
                {actionData.error}
                {deviceLimitEmail && (
                  <Form method="post" action="/auth/release-devices" reloadDocument className="mt-2">
                    <input type="hidden" name="intent" value="request" />
                    <input type="hidden" name="email" value={deviceLimitEmail} />
                    <button type="submit" className="font-medium text-brand-mustard hover:underline">
                      Email me a link to sign out my other devices
                    </button>
                  </Form>
                )}
              </div>
            </div>
          )}

          {/* Step 1: enter key first if not pre-filled (or the key was not found) */}
          {!status && (
            <Form method="get" className="space-y-5">
              {loaderError && (
                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg px-4 py-3 text-sm">
                  <AlertCircle size={15} className="shrink-0" />
                  {loaderError}
                </div>
              )}
              {key && !loaderError && (
                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg px-4 py-3 text-sm">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>
                    We couldn't find a license with the key <span className="font-mono">{key}</span>. Check for typos and try again.
                  </span>
                </div>
              )}
              <div>
                <label
                  htmlFor="key-input"
                  className="block text-sm font-medium text-slate-300 mb-1.5"
                >
                  License Key
                </label>
                {/* No pattern: "lic abcd efgh jkmn" is fine, the server normalises it. */}
                <input
                  id="key-input"
                  name="key"
                  type="text"
                  required
                  defaultValue={key}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm transition uppercase tracking-widest font-mono"
                  placeholder="LIC-XXXX-XXXX-XXXX"
                />
              </div>
              <button
                type="submit"
                className="w-full bg-brand-navy hover:bg-brand-navy-dark text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                Look up key
              </button>
            </Form>
          )}

          {/* Verified license + registration form */}
          {status === "PENDING" && (
            <div className="space-y-6">
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="text-green-400 w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="text-green-300 font-semibold text-sm">
                    Valid license key!
                  </p>
                  <p className="text-green-400/80 text-xs mt-0.5 flex items-center gap-1">
                    <BookOpen size={12} /> {courseTitle}
                  </p>
                  <code className="text-green-300/60 text-xs font-mono mt-1 block">
                    {key}
                  </code>
                </div>
              </div>

              {user ? (
                // Already logged in → just redeem
                <Form method="post" reloadDocument onSubmit={() => setIsSubmitting(true)} className="space-y-4">
                  <input type="hidden" name="key" value={key} />
                  <input type="hidden" name="intent" value="redeem_existing" />
                  {isAdmin && (
                    // Usually a customer's link opened from the admin side: one
                    // click would spend their key, so make it a deliberate choice.
                    <>
                      <div className="flex items-start gap-3 bg-brand-mustard/15 border border-brand-mustard/40 text-slate-200 rounded-lg px-4 py-3 text-sm">
                        <ShieldAlert size={16} className="text-brand-mustard shrink-0 mt-0.5" />
                        <p>
                          You're signed in as an admin. Activating uses this key up for your admin
                          account, so the customer can't use it. Sign out first to redeem it as a
                          student.
                        </p>
                      </div>
                      <label className="flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          name="confirmAdmin"
                          value="1"
                          required
                          className="w-4 h-4 rounded accent-brand-mustard"
                        />
                        Use this key for my admin account
                      </label>
                    </>
                  )}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
                  >
                    {isSubmitting ? "Activating…" : `Activate as ${user.email}`}
                  </button>
                </Form>
              ) : (
                // Create account & redeem
                <Form method="post" reloadDocument onSubmit={() => setIsSubmitting(true)} className="space-y-4">
                  <input type="hidden" name="key" value={key} />
                  <p className="text-slate-400 text-sm">
                    Create an account to access your course:
                  </p>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">
                      Full Name
                    </label>
                    <input
                      name="name"
                      type="text"
                      required
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm"
                      placeholder="Jane Smith"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">
                      Email
                    </label>
                    <input
                      name="email"
                      type="email"
                      defaultValue={prefillEmail}
                      required
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">
                      Password
                    </label>
                    <input
                      name="password"
                      type="password"
                      required
                      minLength={8}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm"
                      placeholder="Min. 8 characters"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
                  >
                    {isSubmitting
                      ? "Activating…"
                      : "Create account & activate course"}
                  </button>
                  <p className="text-center text-xs text-slate-500">
                    Already have an account?{" "}
                    <Link
                      to={`/auth/login?redirect=${encodeURIComponent(`/redeem?key=${encodeURIComponent(key)}`)}`}
                      className="text-brand-mustard hover:text-brand-mustard"
                    >
                      Sign in
                    </Link>
                  </p>
                </Form>
              )}
            </div>
          )}

          {status && status !== "PENDING" && (
            <div className="text-center space-y-3">
              <AlertCircle className="mx-auto text-red-400 w-10 h-10" />
              <p className="text-white font-semibold">
                {status === "REVOKED"
                  ? "This license has been revoked."
                  : "This license has already been redeemed."}
              </p>
              <Link
                to="/auth/login"
                className="inline-block text-brand-mustard hover:text-brand-mustard text-sm font-medium"
              >
                Sign into your account →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
