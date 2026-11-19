-- Licence bookkeeping for Shopify refunds / cancellations, per-line-item
-- idempotency and real revenue. Purely additive: every new column is nullable,
-- so existing rows and the code that predates this migration keep working.
-- IF NOT EXISTS keeps it safe on a database that was ever `db push`-ed.

-- AlterTable
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "shopifyLineItemId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "amountPaid" DOUBLE PRECISION;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "revokedReason" TEXT;

-- AlterTable: a cancellation is remembered on the order itself, so a late or
-- retried orders/paid can't mint keys for an order that was already cancelled.
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ShopifyRefund" (
    "refundId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItems" JSONB,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyRefund_pkey" PRIMARY KEY ("refundId")
);
-- A database that got an earlier ShopifyRefund (e.g. via db push) still needs the column.
ALTER TABLE "ShopifyRefund" ADD COLUMN IF NOT EXISTS "lineItems" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ShopifyRefund_orderId_idx" ON "ShopifyRefund"("orderId");
