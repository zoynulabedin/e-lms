import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { verifyShopifyWebhook } from "../utils/shopify.server";
import {
  processOrderPaid,
  processRefund,
  processOrderCancelled,
  processDispute,
} from "../utils/shopify-orders.server";

const HANDLED_TOPICS = new Set([
  "orders/paid",
  "refunds/create",
  "orders/cancelled",
  "disputes/create",
  "disputes/update",
]);

/**
 * Shopify Webhook Handler
 *
 * Register this ONE URL in your Shopify admin once per event
 * (Settings → Notifications → Webhooks, format JSON):
 *   orders/paid        → issues the keys (see utils/shopify-orders.server.ts)
 *   refunds/create     → revokes the keys of the refunded seats
 *   orders/cancelled   → revokes every key of the order
 *   disputes/create    → a chargeback suspends the order's keys
 *   disputes/update    → a won chargeback restores them
 *   URL: https://yourapp.com/shopify/webhook
 *
 * The processing lives in utils/shopify-orders.server.ts, shared with the
 * admin "Re-sync from Shopify" action. Shopify retries anything that doesn't
 * get a 2xx within ~5s and may deliver an event twice, even concurrently, so
 * every handler is idempotent and only unexpected errors return 5xx.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.warn("[shopify webhook] Invalid HMAC — rejecting request");
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  // No topic header is treated as orders/paid, as this endpoint always has.
  // Other topics signed with the same secret are acknowledged and ignored.
  const topic = request.headers.get("X-Shopify-Topic") || "orders/paid";
  if (!HANDLED_TOPICS.has(topic)) {
    return data({ ok: true, ignored: topic });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return data({ error: "Invalid JSON body" }, { status: 400 });
  }

  const outcome =
    topic === "refunds/create"
      ? await processRefund(payload)
      : topic === "orders/cancelled"
        ? await processOrderCancelled(payload)
        : topic === "disputes/create" || topic === "disputes/update"
          ? await processDispute(payload)
          : await processOrderPaid(payload, "webhook");
  return data(outcome.body, { status: outcome.status });
}

// Shopify also sends GET health checks
export async function loader() {
  return data({ status: "Shopify webhook endpoint active" }, { status: 200 });
}
