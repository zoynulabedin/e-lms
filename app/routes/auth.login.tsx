import { redirect, data } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import {
  verifyPassword,
  createSession,
  createSessionCookie,
  getSessionUser,
} from "../utils/auth.server";
import { Eye, EyeOff, CheckCircle2, Mail, Lock, ArrowLeft } from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (user) {
    return redirect(user.role === "ADMIN" ? "/" : "/student");
  }
  const url = new URL(request.url);
  const passwordReset = url.searchParams.get("reset") === "1";
  return data({ passwordReset });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    return data({ error: "Email and password are required." }, { status: 400 });
  }

  try {
    const users = await prisma.$queryRaw<any[]>`
      SELECT id, email, "passwordHash", name, role, "isBanned", "banReason", "isSuspended"
      FROM "User" WHERE email = ${email} LIMIT 1
    `;
    const user = users[0] ?? null;

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return data({ error: "Invalid email or password." }, { status: 401 });
    }

    if (user.isBanned) {
      return data(
        {
          error: `Your account has been banned${user.banReason ? ": " + user.banReason : ". Contact support for assistance."}`,
        },
        { status: 403 },
      );
    }

    if (user.isSuspended) {
      return data(
        { error: "Your account is suspended. Contact support for assistance." },
        { status: 403 },
      );
    }

    const token = await createSession(user.id, user.role, request);
    const cookie = createSessionCookie(token);

    const destination = user.role === "ADMIN" ? "/?toast=welcome" : "/student?toast=welcome";
    return redirect(destination, {
      headers: { "Set-Cookie": cookie },
    });
  } catch (err) {
    console.error("[login] action error:", err);
    return data(
      { error: "Login failed. Please try again." },
      { status: 500 },
    );
  }
}

// ── Design tokens lifted from the approved login mockup ──────────────────────
const PAGE_BG = "#f6e9dc";
const CARD_BG = "#faf5ee";
const FIELD_BORDER = "#d4cec8";
const NAVY = "#0e2341";
const GOLD = "#d49f4d";

// Top edge of the navy footer band. Traced from the mockup, normalised to a
// 1526×165 box so it stretches with the viewport (preserveAspectRatio="none").
const CURVE =
  "M0,129 C70,150 130,165 191,165 C330,165 420,155 609,152 C800,150 950,151 1150,149 C1260,146 1330,112 1420,76 C1470,55 1500,25 1526,0";

const FEATURES = [
  { icon: "/login/icon-pace.png", lines: ["Learn at", "your own pace"] },
  { icon: "/login/icon-skills.png", lines: ["Build real", "money skills"] },
  { icon: "/login/icon-secure.png", lines: ["Track Your", "Progress"] },
  { icon: "/login/icon-real.png", lines: ["Created for", "real life"] },
];

export default function Login() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const passwordReset =
    loaderData && "passwordReset" in loaderData ? loaderData.passwordReset : false;

  return (
    <div
      className="relative flex min-h-screen flex-col overflow-hidden"
      style={{ backgroundColor: PAGE_BG }}
    >
      {/* ── Doodle background ─────────────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat lg:bg-[length:100%_100%]"
        style={{ backgroundImage: "url('/login/bg.png')" }}
      />

      {/* ── Sage brush accent, top right ──────────────────────────────── */}
      <img
        src="/login/brush.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute top-0 right-0 w-[46%] max-w-[520px] select-none"
      />

      {/* ── Main column ───────────────────────────────────────────────── */}
      <main className="relative z-20 flex flex-1 flex-col items-center px-4 pt-8 pb-10 sm:pt-10 lg:pt-[58px] lg:pb-8">
        <img
          src="/login/logo.png"
          alt="Teach Me Like a Tot"
          className="w-[178px] select-none sm:w-[200px] lg:w-[226px]"
        />

        <h1
          className="mt-3 text-center text-[38px] leading-[1.05] font-extrabold tracking-[-0.02em] sm:text-[50px] lg:text-[65px]"
          style={{ color: NAVY }}
        >
          Welcome back!
        </h1>

        <p className="mt-2 text-center text-[16px] text-slate-700 sm:text-[19px] lg:text-[21px]">
          Ready to make some money make sense?
        </p>

        {/* hand-drawn underline swash */}
        <svg
          aria-hidden
          viewBox="0 0 86 9"
          className="mt-2.5 h-[9px] w-[70px] lg:w-[86px]"
          fill="none"
        >
          <path
            d="M1.5 6.2c14-3.6 30-5 43-4.4 13 .6 26 2.4 40 5"
            stroke={GOLD}
            strokeWidth="3.4"
            strokeLinecap="round"
          />
        </svg>

        {/* ── Card ────────────────────────────────────────────────────── */}
        <div className="mt-6 w-full max-w-[580px] lg:mt-7 lg:translate-x-[52px]">
          <div
            className="rounded-[26px] px-6 py-8 shadow-[0_18px_50px_-12px_rgba(29,55,95,0.18)] sm:px-[45px] sm:pt-[39px] sm:pb-[35px]"
            style={{ backgroundColor: CARD_BG }}
          >
            <Form
              method="post"
              reloadDocument
              onSubmit={() => setIsSubmitting(true)}
            >
              {passwordReset && (
                <div className="mb-5 flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-600/10 px-4 py-3 text-sm text-green-800">
                  <CheckCircle2 size={15} className="shrink-0" />
                  Password updated successfully. Sign in with your new password.
                </div>
              )}

              {actionData?.error && (
                <div className="mb-5 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700">
                  {actionData.error}
                </div>
              )}

              {/* Email */}
              <label
                htmlFor="email"
                className="flex items-center gap-2 text-[15px] font-bold sm:text-[17px]"
                style={{ color: NAVY }}
              >
                <Mail size={19} strokeWidth={2.2} className="text-brand-green" />
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="Enter your email"
                className="mt-3.5 h-[56px] w-full rounded-[11px] border bg-white/55 px-5 text-[16px] text-slate-800 transition outline-none placeholder:text-slate-400 focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20 sm:h-[62px] sm:text-[18px]"
                style={{ borderColor: FIELD_BORDER }}
              />

              {/* Password */}
              <div className="mt-[35px] flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="flex items-center gap-2 text-[15px] font-bold sm:text-[17px]"
                  style={{ color: NAVY }}
                >
                  <Lock size={19} strokeWidth={2.2} className="text-brand-green" />
                  Password
                </label>
                <Link
                  to="/auth/forgot-password"
                  className="text-[14px] font-medium transition-opacity hover:opacity-75 sm:text-[16px]"
                  style={{ color: GOLD }}
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative mt-3">
                <input
                  id="password"
                  name="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder="Enter your password"
                  className="h-[56px] w-full rounded-[11px] border bg-white/55 pr-14 pl-5 text-[16px] text-slate-800 transition outline-none placeholder:text-slate-400 focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20 sm:h-[62px] sm:text-[18px]"
                  style={{ borderColor: FIELD_BORDER }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-4 flex items-center text-slate-500 transition-colors hover:text-slate-700"
                >
                  {showPw ? <EyeOff size={21} /> : <Eye size={21} />}
                </button>
              </div>

              {/* Submit */}
              <button
                id="login-submit"
                type="submit"
                disabled={isSubmitting}
                className="mt-[30px] h-[58px] w-full rounded-[11px] text-[16px] font-bold tracking-[0.06em] text-white uppercase transition-opacity hover:opacity-92 disabled:opacity-60 sm:h-[66px] sm:text-[18px]"
                style={{ backgroundColor: NAVY }}
              >
                {isSubmitting ? "Signing in…" : "Sign in"}
              </button>
            </Form>

            {/* Divider */}
            <div className="mt-[22px] flex items-center gap-4">
              <span className="h-px flex-1" style={{ backgroundColor: FIELD_BORDER }} />
              <span className="text-[15px] text-slate-500">or</span>
              <span className="h-px flex-1" style={{ backgroundColor: FIELD_BORDER }} />
            </div>

            <p className="mt-[20px] text-center text-[15px] text-slate-700 sm:text-[17px]">
              New here?{" "}
              <Link
                to="/auth/register"
                className="font-bold text-brand-green transition-opacity hover:opacity-75"
              >
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </main>

      {/* ── Illustrations sitting on the curve ────────────────────────── */}
      <img
        src="/login/character.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute bottom-[155px] left-[5%] z-10 hidden w-[34.1%] max-w-[521px] select-none lg:block"
      />
      <img
        src="/login/books.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute right-[11.5%] bottom-[183px] z-10 hidden w-[14.75%] max-w-[226px] select-none lg:block"
      />

      {/* ── Navy footer ───────────────────────────────────────────────── */}
      <footer className="relative z-20 mt-auto">
        <svg
          aria-hidden
          viewBox="0 0 1526 165"
          preserveAspectRatio="none"
          className="absolute bottom-full left-0 h-[62px] w-full sm:h-[110px] lg:h-[165px]"
        >
          <path d={`${CURVE} L1526,165 L0,165 Z`} fill={NAVY} />
          <path d={CURVE} fill="none" stroke={GOLD} strokeWidth="4" />
        </svg>

        <div style={{ backgroundColor: NAVY }} className="px-4 pt-4 pb-6 lg:pt-6 lg:pb-7">
          <ul className="mx-auto flex w-full max-w-[900px] flex-wrap items-center justify-center gap-x-0 gap-y-6">
            {FEATURES.map((f, i) => (
              <li
                key={f.lines.join(" ")}
                className={`flex w-1/2 items-center justify-center gap-3 sm:w-1/4 ${
                  i > 0 ? "sm:border-l sm:border-white/15" : ""
                }`}
              >
                <img src={f.icon} alt="" aria-hidden className="h-[38px] w-auto lg:h-[46px]" />
                <span className="text-[14px] leading-[1.25] text-white lg:text-[17px]">
                  {f.lines[0]}
                  <br />
                  {f.lines[1]}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5 text-center lg:mt-4">
            <a
              href="https://www.teachmelikeatot.org"
              className="inline-flex items-center gap-2.5 text-[15px] transition-opacity hover:opacity-75 lg:text-[18px]"
              style={{ color: GOLD }}
            >
              <ArrowLeft size={20} strokeWidth={2.2} />
              Back to Teach Me Like a Tot
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
