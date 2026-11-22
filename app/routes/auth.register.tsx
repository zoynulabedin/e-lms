import { redirect, data } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs, MetaFunction } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Mail } from "lucide-react";
import { prisma } from "../utils/db.server";
import { hashPassword, createSession, createSessionCookie } from "../utils/auth.server";
import { rateLimitResponse, recordAttempt, recordFailure, clientIp, TOO_MANY_ATTEMPTS } from "../utils/rate-limit.server";
import { trustThisDevice } from "../utils/mfa.server";
import { sendRegistrationCodeEmail } from "../utils/email.server";
import { HONEYPOT_FIELD, NAME_MAX, PASSWORD_MAX, PASSWORD_MIN, REGISTRATION_CODE_MINUTES } from "../utils/registration";
import {
  clearPendingRegistrationCookie,
  createPendingRegistrationCookie,
  emailDomainError,
  emailFormatError,
  formTokenProblem,
  issueFormToken,
  maskEmail,
  nameError,
  newRegistrationCode,
  normalizeEmail,
  normalizeName,
  passwordError,
  readPendingRegistration,
  registrationCodeMatches,
  turnstileSiteKey,
  verifyTurnstile,
} from "../utils/registration.server";

/**
 * Public sign-up, in two steps (see utils/registration.server.ts):
 *   1. name, email, password (+ bot checks) → a 6-digit code is emailed
 *   2. the code → the STUDENT account is created and signed in
 * No account exists until the inbox is proven, so fake or mistyped addresses
 * never become accounts.
 */

export const meta: MetaFunction = () => [{ title: "Create account" }];

type Values = { name: string; email: string };
type FieldErrors = Partial<Record<"name" | "email" | "password" | "confirmPassword", string>>;
type ActionResult = {
  step: "form" | "verify";
  error?: string;
  info?: string;
  fieldErrors?: FieldErrors;
  values?: Values;
  maskedEmail?: string;
  /** A fresh form token, when the one the page holds can no longer be used. */
  formToken?: string;
};

const reply = (result: ActionResult, init?: number | ResponseInit) => data(result, init);

export async function loader({ request }: LoaderFunctionArgs) {
  const pending = readPendingRegistration(request);
  return {
    formToken: issueFormToken(),
    turnstileSiteKey: turnstileSiteKey(),
    pendingEmail: pending ? maskEmail(pending.email) : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") || "start");
  if (intent === "restart") {
    return reply({ step: "form" }, { headers: { "Set-Cookie": clearPendingRegistrationCookie() } });
  }
  if (intent === "verify") return verifyCode(request, form);
  if (intent === "resend") return resendCode(request);
  return start(request, form);
}

/** Emails the code. Without an email service outside production the code goes to the server log instead. */
async function deliverCode(to: string, name: string, code: string): Promise<boolean> {
  const sent = await sendRegistrationCodeEmail({ to, name, code });
  if (sent.ok) return true;
  if (process.env.NODE_ENV !== "production" && !process.env.RESEND_API_KEY) {
    console.log(`[register] (dev, no RESEND_API_KEY) sign-up code for ${to}: ${code}`);
    return true;
  }
  return false;
}

// ─── Step 1: details → emailed code ──────────────────────────────────────────

async function start(request: Request, form: FormData) {
  const name = normalizeName(form.get("name"));
  const email = normalizeEmail(form.get("email"));
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  const values: Values = { name, email };

  // Bots fill every field, humans never see this one. Answer as if it worked,
  // so a bot gets no signal to adapt; nothing is sent or stored.
  if (String(form.get(HONEYPOT_FIELD) || "").trim()) {
    console.warn(`[register] honeypot filled from ${clientIp(request)} - ignored`);
    return reply({ step: "verify", maskedEmail: maskEmail(email || "you@example.com") });
  }

  const tokenProblem = formTokenProblem(String(form.get("formToken") || ""));
  if (tokenProblem) {
    if (tokenProblem !== "fast") console.warn(`[register] form token ${tokenProblem} from ${clientIp(request)}`);
    return reply(
      {
        step: "form",
        values,
        formToken: tokenProblem === "fast" ? undefined : issueFormToken(),
        error:
          tokenProblem === "fast"
            ? "That was very quick. Please check your details and press Create account again."
            : "This page was open too long. Please press Create account again.",
      },
      { status: 400 },
    );
  }

  if (!(await verifyTurnstile(String(form.get("cf-turnstile-response") || ""), request))) {
    return reply({ step: "form", values, error: "Please complete the security check, then try again." }, { status: 400 });
  }

  if (rateLimitResponse("register", request, email)) {
    return reply({ step: "form", values, error: TOO_MANY_ATTEMPTS }, { status: 429 });
  }
  recordAttempt("register", request, email);

  const fieldErrors: FieldErrors = {};
  const badName = nameError(name);
  if (badName) fieldErrors.name = badName;
  const badEmail = emailFormatError(email);
  if (badEmail) fieldErrors.email = badEmail;
  const badPassword = passwordError(password, { email, name });
  if (badPassword) fieldErrors.password = badPassword;
  else if (password !== confirmPassword) fieldErrors.confirmPassword = "The two passwords don't match.";
  if (!fieldErrors.email) {
    const noMail = await emailDomainError(email);
    if (noMail) fieldErrors.email = noMail;
  }
  if (Object.keys(fieldErrors).length) return reply({ step: "form", values, fieldErrors }, { status: 400 });

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return reply(
      {
        step: "form",
        values,
        fieldErrors: { email: "An account with this email already exists. Sign in, or use \"Forgot password\" on the sign-in page." },
      },
      { status: 409 },
    );
  }

  if (rateLimitResponse("register_email", request, email)) {
    return reply({ step: "form", values, error: TOO_MANY_ATTEMPTS }, { status: 429 });
  }
  recordAttempt("register_email", request, email);

  const passwordHash = await hashPassword(password);
  const { code, codeHash } = newRegistrationCode(email);
  if (!(await deliverCode(email, name, code))) {
    return reply(
      { step: "form", values, error: "We couldn't send the verification email. Please check the address and try again in a moment." },
      { status: 502 },
    );
  }
  return reply(
    { step: "verify", maskedEmail: maskEmail(email) },
    { headers: { "Set-Cookie": createPendingRegistrationCookie({ name, email, passwordHash, codeHash }) } },
  );
}

// ─── Step 2: code → account ──────────────────────────────────────────────────

const TIMED_OUT = "Your sign-up timed out. Please fill in the form again.";

async function verifyCode(request: Request, form: FormData) {
  const pending = readPendingRegistration(request);
  if (!pending) {
    return reply({ step: "form", error: TIMED_OUT }, { status: 400, headers: { "Set-Cookie": clearPendingRegistrationCookie() } });
  }
  const maskedEmail = maskEmail(pending.email);

  if (rateLimitResponse("register_verify", request, pending.email)) {
    return reply({ step: "verify", maskedEmail, error: "Too many wrong codes. Please wait 15 minutes and try again." }, { status: 429 });
  }
  if (!registrationCodeMatches(pending, String(form.get("code") || ""))) {
    recordFailure("register_verify", request, pending.email);
    return reply({ step: "verify", maskedEmail, error: "That code is not correct. Check the email we sent you and try again." }, { status: 400 });
  }

  // Public sign-up always creates a STUDENT. The first admin is created with
  // scripts/seed-admin.ts - never by whoever registers first on a fresh DB.
  let user;
  try {
    user = await prisma.user.create({
      data: { name: pending.name, email: pending.email, passwordHash: pending.passwordHash, role: "STUDENT" },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return reply(
        { step: "form", error: "An account with this email already exists. Please sign in." },
        { status: 409, headers: { "Set-Cookie": clearPendingRegistrationCookie() } },
      );
    }
    throw e;
  }
  console.log(`[register] new account ${user.email} (email confirmed)`);

  const token = await createSession(user.id, user.role, request);
  // The account was just made in this browser, so it counts as a known device
  // (no emailed new-device code the next time it signs in here).
  const headers = new Headers();
  headers.append("Set-Cookie", createSessionCookie(token));
  headers.append("Set-Cookie", await trustThisDevice(request, user.id));
  headers.append("Set-Cookie", clearPendingRegistrationCookie());
  return redirect("/student?toast=registered", { headers });
}

async function resendCode(request: Request) {
  const pending = readPendingRegistration(request);
  if (!pending) {
    return reply({ step: "form", error: TIMED_OUT }, { status: 400, headers: { "Set-Cookie": clearPendingRegistrationCookie() } });
  }
  const maskedEmail = maskEmail(pending.email);
  if (rateLimitResponse("register_email", request, pending.email)) {
    return reply({ step: "verify", maskedEmail, error: TOO_MANY_ATTEMPTS }, { status: 429 });
  }
  recordAttempt("register_email", request, pending.email);
  const { code, codeHash } = newRegistrationCode(pending.email);
  if (!(await deliverCode(pending.email, pending.name, code))) {
    return reply({ step: "verify", maskedEmail, error: "The email could not be sent. Please try again in a moment." }, { status: 502 });
  }
  return reply(
    { step: "verify", maskedEmail, info: "A new code is on its way. Only the newest code works." },
    { headers: { "Set-Cookie": createPendingRegistrationCookie({ ...pending, codeHash }) } },
  );
}

// ─── UI ──────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; theme?: string }) => string;
      reset: (el?: HTMLElement | string) => void;
    };
  }
}

const inputClass =
  "w-full bg-white/5 border rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm transition";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-xs text-red-400">
      {message}
    </p>
  );
}

export default function Register() {
  const { formToken: initialToken, turnstileSiteKey: siteKey, pendingEmail } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  // The token from the FIRST render stays (loaders re-run after every submit,
  // and a new token would restart the "too fast" clock); a stale one is replaced.
  const [formToken, setFormToken] = useState(initialToken);
  useEffect(() => {
    if (result?.formToken) setFormToken(result.formToken);
  }, [result]);

  const step = result?.step ?? (pendingEmail ? "verify" : "form");
  const maskedEmail = result?.maskedEmail ?? pendingEmail ?? "";

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50 p-2">
            {step === "verify" ? (
              <Mail className="text-white w-8 h-8" />
            ) : (
              <img src="/White_center.avif" alt="Teach Me Like a Tot" className="w-full h-full object-contain" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-white">{step === "verify" ? "Check your email" : "Create account"}</h1>
          <p className="text-slate-400 mt-1 text-sm">
            {step === "verify"
              ? `We sent a 6-digit code to ${maskedEmail}. Enter it below to finish creating your account.`
              : "Register to access your courses"}
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {result?.error && (
            <div role="alert" className="mb-5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
              {result.error}
            </div>
          )}
          {result?.info && (
            <div role="status" className="mb-5 bg-green-500/10 border border-green-500/20 text-green-300 rounded-lg px-4 py-3 text-sm">
              {result.info}
            </div>
          )}

          {step === "verify" ? (
            <VerifyStep busy={busy} />
          ) : (
            <DetailsStep busy={busy} result={result} formToken={formToken} siteKey={siteKey} />
          )}

          <p className="text-center text-sm text-slate-500 mt-6">
            Already have an account?{" "}
            <Link to="/auth/login" className="text-brand-mustard hover:text-brand-mustard font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function DetailsStep({
  busy,
  result,
  formToken,
  siteKey,
}: {
  busy: boolean;
  result: ActionResult | undefined;
  formToken: string;
  siteKey: string | null;
}) {
  const [showPw, setShowPw] = useState(false);
  const fe = result?.fieldErrors ?? {};
  const v = result?.values;
  const turnstileRef = useRef<HTMLDivElement>(null);

  // Turnstile renders itself when its script loads; after a client-side
  // navigation the script is already there, so render explicitly. A token
  // works once, so the widget is reset after every failed submit.
  useEffect(() => {
    const el = turnstileRef.current;
    if (siteKey && el && window.turnstile && !el.hasChildNodes()) {
      window.turnstile.render(el, { sitekey: siteKey, theme: "dark" });
    }
  }, [siteKey]);
  useEffect(() => {
    if (result && turnstileRef.current && window.turnstile) window.turnstile.reset(turnstileRef.current);
  }, [result]);

  const border = (key: keyof FieldErrors) => (fe[key] ? "border-red-500/60" : "border-white/10");

  return (
    <Form method="post" className="space-y-5">
      <input type="hidden" name="intent" value="start" />
      <input type="hidden" name="formToken" value={formToken} />
      {/* Honeypot: off-screen and skipped by keyboard and screen readers. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
        <label htmlFor={HONEYPOT_FIELD}>Website</label>
        <input id={HONEYPOT_FIELD} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div>
        <label htmlFor="name" className="block text-sm font-medium text-slate-300 mb-1.5">
          Full name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          minLength={3}
          maxLength={NAME_MAX}
          defaultValue={v?.name ?? ""}
          aria-invalid={!!fe.name}
          aria-describedby={fe.name ? "name-error" : "name-hint"}
          className={`${inputClass} ${border("name")}`}
          placeholder="Jane Smith"
        />
        {fe.name ? (
          <FieldError id="name-error" message={fe.name} />
        ) : (
          <p id="name-hint" className="mt-1.5 text-xs text-slate-500">
            First and last name, as it should appear on your certificates.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1.5">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          defaultValue={v?.email ?? ""}
          aria-invalid={!!fe.email}
          aria-describedby={fe.email ? "email-error" : "email-hint"}
          className={`${inputClass} ${border("email")}`}
          placeholder="you@example.com"
        />
        {fe.email ? (
          <FieldError id="email-error" message={fe.email} />
        ) : (
          <p id="email-hint" className="mt-1.5 text-xs text-slate-500">
            We'll email you a code to confirm it's yours.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1.5">
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            aria-invalid={!!fe.password}
            aria-describedby={fe.password ? "password-error" : "password-hint"}
            className={`${inputClass} pr-10 ${border("password")}`}
            placeholder={`Min. ${PASSWORD_MIN} characters`}
          />
          <button
            type="button"
            onClick={() => setShowPw((s) => !s)}
            aria-label={showPw ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-3 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {fe.password ? (
          <FieldError id="password-error" message={fe.password} />
        ) : (
          <p id="password-hint" className="mt-1.5 text-xs text-slate-500">
            At least {PASSWORD_MIN} characters, with letters and numbers.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300 mb-1.5">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={showPw ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          aria-invalid={!!fe.confirmPassword}
          aria-describedby={fe.confirmPassword ? "confirmPassword-error" : undefined}
          className={`${inputClass} ${border("confirmPassword")}`}
          placeholder="Type it again"
        />
        <FieldError id="confirmPassword-error" message={fe.confirmPassword} />
      </div>

      {siteKey && (
        <>
          <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          <div ref={turnstileRef} className="cf-turnstile" data-sitekey={siteKey} data-theme="dark" />
        </>
      )}

      <button
        id="register-submit"
        type="submit"
        disabled={busy}
        className="w-full bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors shadow-lg shadow-brand-navy-dark/30 text-sm"
      >
        {busy ? "Checking your details…" : "Create account"}
      </button>
    </Form>
  );
}

function VerifyStep({ busy }: { busy: boolean }) {
  return (
    <div className="space-y-4">
      <Form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="verify" />
        <label htmlFor="code" className="block text-sm font-medium text-slate-300">
          Verification code
        </label>
        <input
          id="code"
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="123456"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white text-center text-xl tracking-[0.4em] placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-mustard"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold py-2.5 rounded-lg disabled:opacity-60"
        >
          {busy ? "Checking…" : "Confirm and create account"}
        </button>
      </Form>
      <p className="text-xs text-slate-500">
        The code expires in {REGISTRATION_CODE_MINUTES} minutes. Can't find it? Check your spam folder.
      </p>
      <div className="flex items-center justify-between text-xs">
        <Form method="post">
          <input type="hidden" name="intent" value="resend" />
          <button type="submit" disabled={busy} className="text-brand-mustard hover:underline disabled:opacity-60">
            Send a new code
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="restart" />
          <button type="submit" disabled={busy} className="text-slate-400 hover:text-slate-200 disabled:opacity-60">
            Use a different email
          </button>
        </Form>
      </div>
    </div>
  );
}
