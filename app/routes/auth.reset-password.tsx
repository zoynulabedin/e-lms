import { redirect, data } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { hashPassword } from "../utils/auth.server";
import { Store, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return data({ valid: false, token: "" });

  const reset = await prisma.passwordReset.findUnique({ where: { token } });
  if (!reset || reset.expiresAt < new Date()) {
    return data({ valid: false, token });
  }

  return data({ valid: true, token });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const token = String(formData.get("token") || "");
  const password = String(formData.get("password") || "");

  if (password.length < 8) {
    return data(
      { error: "Password must be at least 8 characters." },
      { status: 400 },
    );
  }

  const reset = await prisma.passwordReset.findUnique({ where: { token } });
  if (!reset || reset.expiresAt < new Date()) {
    return data(
      { error: "This reset link has expired or is invalid." },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: reset.userId },
    data: { passwordHash },
  });
  await prisma.passwordReset.delete({ where: { token } });

  return redirect("/auth/login?reset=1");
}

export default function ResetPassword() {
  const { valid, token } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-navy-dark via-brand-green-dark to-brand-navy-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-brand-navy rounded-2xl mb-4 shadow-lg shadow-brand-navy-dark/50">
            <Store className="text-white w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-white">Set new password</h1>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
          {!valid ? (
            <div className="text-center space-y-4">
              <p className="text-red-400 font-medium">
                This reset link is invalid or has expired.
              </p>
              <Link
                to="/auth/forgot-password"
                className="inline-block text-brand-mustard hover:text-brand-mustard text-sm font-medium transition-colors"
              >
                Request a new link
              </Link>
            </div>
          ) : (
            <Form method="post" className="space-y-5">
              <input type="hidden" name="token" value={token} />
              {actionData?.error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {actionData.error}
                </div>
              )}
              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-slate-300 mb-1.5"
                >
                  New Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPw ? "text" : "password"}
                    required
                    minLength={8}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 pr-10 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-navy text-sm transition"
                    placeholder="Min. 8 characters"
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
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
              >
                {isSubmitting ? "Updating…" : "Update password"}
              </button>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
