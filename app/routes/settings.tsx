import { data } from "react-router";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import {
  CheckCircle2,
  ExternalLink,
  ShoppingBag,
  Mail,
  Shield,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  return {
    shopifyDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
    hasResendKey: !!process.env.RESEND_API_KEY,
    hasShopifySecret: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    appUrl: process.env.APP_URL || "http://localhost:5173",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
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
  const { shopifyDomain, hasResendKey, hasShopifySecret, appUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const webhookUrl = `${appUrl}/shopify/webhook`;

  return (
    <div className="space-y-8 max-w-3xl">
      <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>

      {actionData?.info && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-lg px-4 py-3 text-sm">
          {actionData.info}
        </div>
      )}

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
            Register this URL in your Shopify admin under{" "}
            <a
              href={`https://${shopifyDomain}/admin/settings/notifications`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-navy hover:underline inline-flex items-center gap-0.5"
            >
              Settings → Notifications <ExternalLink size={11} />
            </a>{" "}
            for the <strong>orders/paid</strong> event.
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
JWT_SECRET=your-strong-secret
SESSION_SECRET=your-session-secret
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com
SHOPIFY_WEBHOOK_SECRET=...
SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
APP_URL=https://yourapp.com`}
        </pre>
      </div>
    </div>
  );
}
