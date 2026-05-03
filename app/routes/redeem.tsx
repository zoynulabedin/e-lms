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
  createSession,
  createSessionCookie,
} from "../utils/auth.server";
import { Key, CheckCircle2, AlertCircle, BookOpen } from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!key) return { key: "", license: null, user: null };

  const sessionUser = await getSessionUser(request);
  const license = await prisma.license.findUnique({
    where: { key },
    include: { course: true },
  });

  return { key, license, user: sessionUser };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const key = String(formData.get("key") || "")
    .trim()
    .toUpperCase();
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") || "");
  const intent = String(formData.get("intent") || "");

  if (!key) return data({ error: "License key is required." }, { status: 400 });

  const license = await prisma.license.findUnique({
    where: { key },
    include: { course: true },
  });

  if (!license) return data({ error: "Invalid license key." }, { status: 404 });
  if (license.status === "REVOKED")
    return data({ error: "This license has been revoked." }, { status: 403 });
  if (license.status === "ACTIVE")
    return data(
      { error: "This license key has already been redeemed." },
      { status: 409 },
    );

  // ─── Get or create user ───────────────────────────────────────────────────
  let userId: string;
  let responseHeaders: Record<string, string> = {};

  if (intent === "redeem_existing") {
    // User is already logged in
    const sessionUser = await getSessionUser(request);
    if (!sessionUser)
      return redirect(`/auth/login?redirect=/redeem?key=${key}`);
    userId = sessionUser.id;
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
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await hashPassword(password);
      user = await prisma.user.create({
        data: { name, email, passwordHash, role: "STUDENT" },
      });
    }
    userId = user.id;
    const token = await createSession(userId, user.role, request);
    responseHeaders["Set-Cookie"] = createSessionCookie(token);
  }

  // Activate license
  await prisma.license.update({
    where: { key },
    data: { status: "ACTIVE", userId, redeemedAt: new Date() },
  });

  // Create enrollment + progress records
  await prisma.enrollment.upsert({
    where: { userId_courseId: { userId, courseId: license.courseId } },
    update: {},
    create: { userId, courseId: license.courseId },
  });

  await prisma.progress.upsert({
    where: { userId_courseId: { userId, courseId: license.courseId } },
    update: {},
    create: { userId, courseId: license.courseId },
  });

  return redirect(`/student/course/${license.courseId}`, {
    headers: responseHeaders,
  });
}

export default function Redeem() {
  const { key: paramKey, license, user } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-green-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-[#2C795A] rounded-2xl mb-4 shadow-lg shadow-green-900/50">
            <Key className="text-white w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white">Redeem Your License</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Enter your license key to unlock your course
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {actionData?.error && (
            <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm mb-5">
              <AlertCircle size={16} className="shrink-0" />
              {actionData.error}
            </div>
          )}

          {/* Step 1: enter key first if not pre-filled */}
          {!paramKey && !license && (
            <Form method="get" className="space-y-5">
              <div>
                <label
                  htmlFor="key-input"
                  className="block text-sm font-medium text-slate-300 mb-1.5"
                >
                  License Key
                </label>
                <input
                  id="key-input"
                  name="key"
                  type="text"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[#2C795A] text-sm transition uppercase tracking-widest font-mono"
                  placeholder="LIC-XXXX-XXXX-XXXX"
                />
              </div>
              <button
                type="submit"
                className="w-full bg-[#2C795A] hover:bg-[#225A43] text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                Look up key
              </button>
            </Form>
          )}

          {/* Verified license + registration form */}
          {license && license.status === "PENDING" && (
            <div className="space-y-6">
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="text-green-400 w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="text-green-300 font-semibold text-sm">
                    Valid license key!
                  </p>
                  <p className="text-green-400/80 text-xs mt-0.5 flex items-center gap-1">
                    <BookOpen size={12} /> {license.course.title}
                  </p>
                  <code className="text-green-300/60 text-xs font-mono mt-1 block">
                    {license.key}
                  </code>
                </div>
              </div>

              {user ? (
                // Already logged in → just redeem
                <Form method="post" reloadDocument onSubmit={() => setIsSubmitting(true)}>
                  <input type="hidden" name="key" value={paramKey} />
                  <input type="hidden" name="intent" value="redeem_existing" />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-[#2C795A] hover:bg-[#225A43] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
                  >
                    {isSubmitting ? "Activating…" : `Activate as ${user.email}`}
                  </button>
                </Form>
              ) : (
                // Create account & redeem
                <Form method="post" reloadDocument onSubmit={() => setIsSubmitting(true)} className="space-y-4">
                  <input type="hidden" name="key" value={paramKey} />
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
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[#2C795A] text-sm"
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
                      defaultValue={
                        license.customerEmail !== "pending@customer.com"
                          ? license.customerEmail
                          : ""
                      }
                      required
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[#2C795A] text-sm"
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
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[#2C795A] text-sm"
                      placeholder="Min. 8 characters"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full bg-[#2C795A] hover:bg-[#225A43] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
                  >
                    {isSubmitting
                      ? "Activating…"
                      : "Create account & activate course"}
                  </button>
                  <p className="text-center text-xs text-slate-500">
                    Already have an account?{" "}
                    <Link
                      to={`/auth/login?redirect=/redeem?key=${paramKey}`}
                      className="text-[#C69445] hover:text-[#C69445]"
                    >
                      Sign in
                    </Link>
                  </p>
                </Form>
              )}
            </div>
          )}

          {license && license.status !== "PENDING" && (
            <div className="text-center space-y-3">
              <AlertCircle className="mx-auto text-red-400 w-10 h-10" />
              <p className="text-white font-semibold">
                {license.status === "REVOKED"
                  ? "This license has been revoked."
                  : "This license has already been redeemed."}
              </p>
              <Link
                to="/auth/login"
                className="inline-block text-[#C69445] hover:text-[#C69445] text-sm font-medium"
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
