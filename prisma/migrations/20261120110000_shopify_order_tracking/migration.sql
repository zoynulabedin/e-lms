-- Shopify order reconciliation. Purely additive: every new column is nullable,
-- so existing rows and the code that predates this migration keep working.
-- IF NOT EXISTS keeps it safe on a database that was ever `db push`-ed.

-- AlterTable: the order number staff see in Shopify ("#1001"), next to the
-- internal order id the keys already carry.
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "shopifyOrderName" TEXT;

-- AlterTable: order number and buyer email per processed order, and the paid
-- line items that matched no course (previously only in an admin email).
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "orderName" TEXT;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "customerEmail" TEXT;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "unmappedItems" JSONB;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "unmappedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "License_shopifyOrderName_idx" ON "License"("shopifyOrderName");
CREATE INDEX IF NOT EXISTS "ShopifyOrder_unmappedAt_idx" ON "ShopifyOrder"("unmappedAt");
