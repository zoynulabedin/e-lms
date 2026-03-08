import { data } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { sendPasswordResetEmail } from "../utils/email.server";
import crypto from "crypto";
import { Store, Mail } from "lucide-react";

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();

  if (!email) {
    return data({ error: "Email is required." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always return success to prevent email enumeration
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    await prisma.passwordReset.create({
      data: { userId: user.id, token, expiresAt },
    });
    await sendPasswordResetEmail({ to: email, token });
  }

  return data({ success: true });
}

export default function ForgotPassword() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-green-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-[#008060] rounded-2xl mb-4 shadow-lg shadow-green-900/50">
            <Store className="text-white w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white">Forgot password?</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Enter your email and we'll send a reset link
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {actionData?.success ? (
            <div className="text-center space-y-4">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-green-500/20 rounded-full mb-2">
                <Mail className="text-green-400 w-6 h-6" />
              </div>
              <p className="text-white font-semibold">Check your inbox</p>
              <p className="text-slate-400 text-sm">
                If an account with that email exists, we've sent a password
                reset link. Check your spam folder if you don't see it.
              </p>
              <Link
                to="/auth/login"
                className="inline-block text-[#00c896] hover:text-[#00e6ac] text-sm font-medium mt-2 transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <Form method="post" className="space-y-5">
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
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-[#008060] text-sm transition"
                  placeholder="you@example.com"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-[#008060] hover:bg-[#006e52] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                {isSubmitting ? "Sending…" : "Send reset link"}
              </button>
              <p className="text-center text-sm text-slate-500">
                <Link
                  to="/auth/login"
                  className="text-[#00c896] hover:text-[#00e6ac] font-medium transition-colors"
                >
                  Back to sign in
                </Link>
              </p>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
