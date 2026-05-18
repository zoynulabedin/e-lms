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
import { Store, Eye, EyeOff, CheckCircle2 } from "lucide-react";
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

export default function Login() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const passwordReset = loaderData && "passwordReset" in loaderData ? loaderData.passwordReset : false;

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50 p-2">
            <img
              src="/White_center.avif"
              alt="Teach Me Like a Tot"
              className="w-full h-full object-contain"
            />
          </div>
          <h1 className="text-2xl font-bold text-white">Welcome back</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Sign in to your LMS account
          </p>
        </div>

        {/* Card */}
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {passwordReset && (
            <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 rounded-lg px-4 py-3 text-sm mb-5">
              <CheckCircle2 size={15} className="shrink-0" />
              Password updated successfully. Sign in with your new password.
            </div>
          )}
          <Form method="post" reloadDocument onSubmit={() => setIsSubmitting(true)} className="space-y-5">
            {actionData?.error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
                {actionData.error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-slate-300 mb-1.5"
              >
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy focus:border-transparent text-sm transition"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-slate-300"
                >
                  Password
                </label>
                <Link
                  to="/auth/forgot-password"
                  className="text-xs text-brand-mustard hover:text-brand-mustard transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 pr-10 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy focus:border-transparent text-sm transition"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute inset-y-0 right-3 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              id="login-submit"
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors shadow-lg shadow-brand-navy-dark/30 text-sm"
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </Form>

          <p className="text-center text-sm text-slate-500 mt-6">
            Don't have an account?{" "}
            <Link
              to="/auth/register"
              className="text-brand-mustard hover:text-brand-mustard font-medium transition-colors"
            >
              Register
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
