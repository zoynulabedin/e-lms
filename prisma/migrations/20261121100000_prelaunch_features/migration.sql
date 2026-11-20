-- Pre-launch features: two-step verification (MFA), new-device verification
-- and device release, bundles, organizations (seat pools and invitations),
-- order reconciliation details and payment disputes.
-- Additive only: new tables and nullable / defaulted columns, so existing rows
-- and the previous build keep working. IF NOT EXISTS / guarded constraints
-- keep it safe on a database that was ever `db push`-ed.

-- AlterTable: bundle products that also unlock a course
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "shopifyBundleProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: organization seat pool and invitations
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "assignedEmail" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "invitedAt" TIMESTAMP(3);
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- AlterTable: reconciliation details per order
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "currency" TEXT;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "financialStatus" TEXT;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "lineItems" JSONB;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "ShopifyOrder" ADD COLUMN IF NOT EXISTS "totalPrice" TEXT;

-- AlterTable: MFA and organization managers
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaLastStep" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "contactEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ShopifyDispute" (
    "disputeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT,
    "status" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopifyDispute_pkey" PRIMARY KEY ("disputeId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");
CREATE INDEX IF NOT EXISTS "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");
CREATE INDEX IF NOT EXISTS "AuthToken_userId_purpose_idx" ON "AuthToken"("userId", "purpose");
CREATE INDEX IF NOT EXISTS "AuthToken_tokenHash_idx" ON "AuthToken"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_shopifyCustomerId_key" ON "Organization"("shopifyCustomerId");
CREATE INDEX IF NOT EXISTS "ShopifyDispute_orderId_idx" ON "ShopifyDispute"("orderId");
CREATE INDEX IF NOT EXISTS "License_organizationId_idx" ON "License"("organizationId");
CREATE INDEX IF NOT EXISTS "ShopifyOrder_organizationId_idx" ON "ShopifyOrder"("organizationId");
CREATE INDEX IF NOT EXISTS "User_organizationId_idx" ON "User"("organizationId");

-- AddForeignKey (guarded: ADD CONSTRAINT has no IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ShopifyOrder" ADD CONSTRAINT "ShopifyOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "License" ADD CONSTRAINT "License_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
