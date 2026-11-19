/**
 * Shopify product ids as the course builder stores them and the webhook
 * matches them. Pure helpers (no Prisma), safe to import anywhere.
 *
 * The orders/paid payload carries a bare numeric `product_id`, but admins
 * paste whatever Shopify shows them: the numeric id, a GraphQL GID
 * ("gid://shopify/Product/123") or the admin URL
 * (".../admin/products/123" or "admin.shopify.com/store/x/products/123").
 * Anything but the bare number never matched, and the order then minted no
 * key at all - so the builder stores the number.
 */
export function normalizeShopifyProductId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const gid = s.match(/^gid:\/\/shopify\/Product\/(\d+)(?:[/?#].*)?$/i);
  if (gid) return gid[1];
  const url = s.match(/\/products\/(\d+)(?:[/?#].*)?$/i);
  if (url) return url[1];
  return s;
}

/**
 * Every stored form one numeric product id may have been saved as before the
 * builder normalised it, for the webhook's lookup.
 */
export function shopifyProductIdVariants(productId: string): string[] {
  const id = productId.trim();
  if (!id) return [];
  return [id, `gid://shopify/Product/${id}`];
}
