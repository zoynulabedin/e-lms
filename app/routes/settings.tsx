import { data } from "react-router";
import {
  Form,
  Link,
  useLoaderData,
  useActionData,
  useNavigation,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import { prisma } from "../utils/db.server";
import { verifyUserTotp, issueRecoveryCodes } from "../utils/mfa.server";
import { rateLimitResponse, recordFailure, TOO_MANY_ATTEMPTS } from "../utils/rate-limit.server";
import { shopifyAdminConfigured } from "../utils/shopify-admin.server";
import {
  CheckCircle2,
  ExternalLink,
  ShoppingBag,
  Mail,
  Shield,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  const admin = await requireAdmin(request);
  const unusedRecovery = await prisma.mfaRecoveryCode.count({ where: { userId: admin.id, usedAt: null } });
  return {
    unusedRecovery,
    canResync: shopifyAdminConfigured(),
    shopifyDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
    hasResendKey: !!process.env.RESEND_API_KEY,
    hasShopifySecret: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    appUrl: process.env.APP_URL || "http://localhost:5173",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const form = await request.formData();
  // New recovery codes for this admin's own two-step verification.
  if (form.get("intent") === "mfa_codes") {
    if (rateLimitResponse("mfa_verify", request, admin.id)) return data({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
    if (!(await verifyUserTotp(admin.id, String(form.get("code") || "")))) {
      recordFailure("mfa_verify", request, admin.id);
      return data({ error: "That code is not correct." }, { status: 400 });
    }
    return data({ codes: await issueRecoveryCodes(admin.id) });
  }
  // In a real app, settings would be persisted in the DB or a config file.
  // For this implementation, we remind the admin to set env vars.
  return data({
    info: "Settings are managed via environment variables. Update your .env file and restart the server.",
  });
}

function SettingRow({
  icon: Icon,
  title,
  description,
  badge,
  badgeOk,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  badge?: string;
  badgeOk?: boolean;
}) {
  return (
    <div className="flex items-start gap-4 py-5 border-b border-gray-100 last:border-0">
      <div className="shrink-0 w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center">
        <Icon className="w-4 h-4 text-gray-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{title}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      {badge && (
        <span
          className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeOk ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}
        >
          {badgeOk && <CheckCircle2 size={11} />}
          {badge}
        </span>
      )}
    </div>
  );
}

export default function Settings() {
  const { shopifyDomain, hasResendKey, hasShopifySecret, appUrl, unusedRecovery, canResync } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const webhookUrl = `${appUrl}/shopify/webhook`;

  return (
    <div className="space-y-8 max-w-3xl">
      <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>

      {actionData && "info" in actionData && actionData.info && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-lg px-4 py-3 text-sm">
          {actionData.info}
        </div>
      )}

      {/* Your two-step verification (always on for admins) */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Shield size={16} className="text-brand-navy" /> Your two-step verification
          </h2>
        </div>
        <div className="px-6 py-5 space-y-3 text-sm text-gray-700">
          <p>
            On (required for administrators). {unusedRecovery} unused recovery code{unusedRecovery === 1 ? "" : "s"} left.
            A user who loses their phone can be reset on the Users page; you can't reset your own.
          </p>
          {actionData && "codes" in actionData && actionData.codes && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
              <p className="font-semibold">New recovery codes - save them now, they are shown once:</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">{actionData.codes.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          {actionData && "error" in actionData && actionData.error && <p className="text-red-700">{actionData.error}</p>}
          <Form method="post" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="intent" value="mfa_codes" />
            <input name="code" required inputMode="numeric" maxLength={6} placeholder="Google Authenticator code" aria-label="Google Authenticator code" className="w-44 border border-gray-300 rounded-md px-3 py-1.5" />
            <button type="submit" className="bg-brand-navy text-white px-4 py-1.5 rounded-md font-medium hover:bg-brand-navy-dark">Create new recovery codes</button>
          </Form>
        </div>
      </div>

      {/* Shopify Integration */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <ShoppingBag size={16} className="text-brand-navy" /> Shopify
            Integration
          </h2>
        </div>
        <div className="px-6">
          <SettingRow
            icon={ShoppingBag}
            title="Store Domain"
            description={
              shopifyDomain || "Set SHOPIFY_STORE_DOMAIN in your .env file"
            }
            badge={shopifyDomain ? "Connected" : "Not set"}
            badgeOk={!!shopifyDomain}
          />
          <SettingRow
            icon={Shield}
            title="Webhook Secret"
            description="Used to verify incoming Shopify webhook payloads (SHOPIFY_WEBHOOK_SECRET)"
            badge={hasShopifySecret ? "Configured" : "Not set"}
            badgeOk={hasShopifySecret}
          />
          <SettingRow
            icon={ShoppingBag}
            title="Admin API (order re-sync)"
            description="Lets the Orders page pull an order whose webhook was lost (SHOPIFY_ACCESS_TOKEN with read_orders)"
            badge={canResync ? "Configured" : "Not set - re-sync off"}
            badgeOk={canResync}
          />
        </div>

        {/* Webhook URL */}
        <div className="px-6 pb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
            Webhook Endpoint URL
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5 text-sm font-mono text-gray-700 truncate">
              {webhookUrl}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(webhookUrl)}
              className="shrink-0 text-xs text-brand-navy border border-brand-navy/30 hover:bg-brand-navy/5 px-3 py-2.5 rounded-lg transition-colors font-medium whitespace-nowrap"
            >
              Copy
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Register this <strong>same URL</strong> in your Shopify admin under{" "}
            <a
              href={`https://${shopifyDomain}/admin/settings/notifications`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-navy hover:underline inline-flex items-center gap-0.5"
            >
              Settings → Notifications → Webhooks <ExternalLink size={11} />
            </a>{" "}
            three times, once for each event, with the format set to{" "}
            <strong>JSON</strong>:
          </p>
          <ul className="text-xs text-gray-400 mt-1.5 space-y-0.5 list-disc pl-5">
            <li>
              <strong>orders/paid</strong> (Order payment) — creates the
              license keys and emails them to the buyer
            </li>
            <li>
              <strong>refunds/create</strong> (Refund create) — revokes the
              keys of the refunded items
            </li>
            <li>
              <strong>orders/cancelled</strong> (Order cancellation) — revokes
              every key of the order
            </li>
          </ul>
          <p className="text-xs text-gray-400 mt-1.5">
            A refund or cancellation revokes the matching keys automatically
            and emails you the list. A key revoked by mistake can be restored on
            the{" "}
            <Link
              to="/licenses?status=REVOKED"
              className="text-brand-navy hover:underline"
            >
              License Keys
            </Link>{" "}
            page.
          </p>
        </div>
      </div>

      {/* Email */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Mail size={16} className="text-brand-navy" /> Email (Resend)
          </h2>
        </div>
        <div className="px-6">
          <SettingRow
            icon={Mail}
            title="Resend API Key"
            description="Used for sending license keys and password reset emails (RESEND_API_KEY)"
            badge={hasResendKey ? "Configured" : "Not set — emails disabled"}
            badgeOk={hasResendKey}
          />
        </div>
      </div>

      {/* Env reference */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          Required Environment Variables
        </h2>
        <pre className="text-xs text-slate-600 leading-relaxed font-mono overflow-x-auto">
          {`DATABASE_URL=postgresql://...
JWT_SECRET=your-strong-secret        # >= 16 chars, required in production
COOKIE_SECURE=true                   # HTTPS only (default in production)
APP_URL=https://yourapp.com          # required in production (email links)
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com
SUPPORT_EMAIL=help@yourdomain.com    # optional: Reply-To on customer emails (default info@instructionalgraphics.org)
ADMIN_EMAIL=you@yourdomain.com       # Shopify order notifications
SHOPIFY_WEBHOOK_SECRET=...
SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...       # optional: order re-sync (read_orders scope)
SHOPIFY_API_VERSION=2026-07          # optional: Admin API version for re-sync
NEW_DEVICE_VERIFICATION=false        # optional: turn off emailed new-device codes
TRUST_PROXY=true                     # behind Plesk/nginx: turns on per-IP rate limits
TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY  # optional: Cloudflare bot check on sign-up
SHOPIFY_ALLOW_TEST_ORDERS=true       # STAGING ONLY: test orders issue real keys
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD   # only for scripts/seed-admin.ts`}
        </pre>
      </div>
    </div>
  );
}
