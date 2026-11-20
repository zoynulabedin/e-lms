/**
 * Minimal Shopify Admin REST client, used by the admin "Re-sync from Shopify"
 * action: when a webhook delivery was lost (Shopify stops retrying after a
 * while) the order can be pulled again and run through the same rules
 * (utils/shopify-orders.server.ts). The REST order resource has the same shape
 * as the webhook payloads.
 *
 * Needs SHOPIFY_STORE_DOMAIN (yourstore.myshopify.com) and SHOPIFY_ACCESS_TOKEN
 * (a custom app's Admin API token with the read_orders scope).
 * SHOPIFY_API_VERSION picks the API version (default below).
 */

const DEFAULT_API_VERSION = "2026-07";
const TIMEOUT_MS = 10_000;

function config(): { base: string; token: string } | null {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const token = (process.env.SHOPIFY_ACCESS_TOKEN ?? "").trim();
  if (!domain || !token || token.startsWith("shpat_your")) return null;
  const version = (process.env.SHOPIFY_API_VERSION ?? "").trim() || DEFAULT_API_VERSION;
  return { base: `https://${domain}/admin/api/${version}`, token };
}

/** True when re-sync can be offered (store domain and an access token are set). */
export function shopifyAdminConfigured(): boolean {
  return config() !== null;
}

/** The store's own admin page for an order, for "Open in Shopify" links. */
export function shopifyAdminOrderUrl(orderId: string): string | null {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return domain ? `https://${domain}/admin/orders/${encodeURIComponent(orderId)}` : null;
}

export class ShopifyAdminError extends Error {}

async function get(path: string): Promise<any> {
  const cfg = config();
  if (!cfg) throw new ShopifyAdminError("Shopify Admin API is not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN).");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      headers: { "X-Shopify-Access-Token": cfg.token, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new ShopifyAdminError("Shopify refused the access token - check SHOPIFY_ACCESS_TOKEN and its read_orders scope.");
    }
    if (!res.ok) throw new ShopifyAdminError(`Shopify answered ${res.status}.`);
    return await res.json();
  } catch (e: any) {
    if (e instanceof ShopifyAdminError) throw e;
    throw new ShopifyAdminError(e?.name === "AbortError" ? "Shopify did not answer in time." : `Could not reach Shopify: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The order by Shopify's internal id, or null when Shopify has no such order. */
export async function fetchShopifyOrder(orderId: string): Promise<any | null> {
  if (!/^\d+$/.test(orderId)) return null;
  const body = await get(`/orders/${orderId}.json`);
  return body?.order ?? null;
}

/** The order by the number staff see ("#1001" or "1001"), or null. */
export async function findShopifyOrderByName(name: string): Promise<any | null> {
  const clean = name.trim().replace(/^#/, "");
  if (!clean) return null;
  for (const candidate of [`#${clean}`, clean]) {
    const body = await get(`/orders.json?status=any&limit=1&name=${encodeURIComponent(candidate)}`);
    const order = body?.orders?.[0];
    if (order) return order;
  }
  return null;
}
