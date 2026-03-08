import crypto from "crypto";

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";

/**
 * Verify that a Shopify webhook request is authentic by comparing
 * the HMAC-SHA256 signature in the header with one we compute ourselves.
 */
export function verifyShopifyWebhook(
  rawBody: string,
  hmacHeader: string | null,
): boolean {
  if (!SHOPIFY_SECRET || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  // Use timingSafeEqual to prevent timing attacks
  try {
    const digestBuffer = Buffer.from(digest);
    const hmacBuffer = Buffer.from(hmacHeader);
    if (digestBuffer.length !== hmacBuffer.length) return false;
    return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
  } catch {
    return false;
  }
}
