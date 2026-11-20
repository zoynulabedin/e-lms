/**
 * Bulk-generated keys have no buyer yet; this sentinel marks that state so
 * the redeem form doesn't pre-fill it and "Resend Email" refuses to mail it.
 * One definition, used by licenses.tsx and redeem.tsx.
 *
 * This module is imported by route components, so it must stay free of
 * server-only code (no Prisma). Database helpers live in license.server.ts.
 */
export const PLACEHOLDER_EMAIL = "unassigned@placeholder.com";

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const e = email.toLowerCase();
  return e === PLACEHOLDER_EMAIL || e === "pending@customer.com" || e.endsWith("@placeholder.com");
}

/**
 * Canonical form of a typed / pasted licence key.
 *
 * Every key ever generated has the shape `LIC-XXXX-XXXX-XXXX`, so whatever the
 * learner typed is reduced to its letters and digits and re-formatted: spaces,
 * missing or extra dashes, lowercase and a missing `LIC` prefix all resolve to
 * the stored key. Input that does not have that shape is returned trimmed and
 * upper-cased, so it simply fails the lookup.
 */
export function normalizeLicenseKey(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  const compact = s.replace(/[^A-Z0-9]/g, "");
  const body = /^LIC[A-Z0-9]{12}$/.test(compact)
    ? compact.slice(3)
    : /^[A-Z0-9]{12}$/.test(compact)
      ? compact
      : null;
  if (!body) return s;
  return `LIC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** Stored in License.revokedReason. */
export const REVOKE_REASON = {
  ADMIN: "ADMIN",
  REFUND: "REFUND",
  CANCELLED: "CANCELLED",
  USER_DELETED: "USER_DELETED",
  // Suspended while a Shopify chargeback is open; restored if the shop wins.
  DISPUTE: "DISPUTE",
} as const;

export type RevokeReason = (typeof REVOKE_REASON)[keyof typeof REVOKE_REASON];

/** Human label for License.revokedReason (null = revoked before reasons were recorded). */
export function revokeReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case REVOKE_REASON.ADMIN:
      return "Revoked by an admin";
    case REVOKE_REASON.REFUND:
      return "Refunded in Shopify";
    case REVOKE_REASON.CANCELLED:
      return "Order cancelled in Shopify";
    case REVOKE_REASON.USER_DELETED:
      return "Account deleted";
    case REVOKE_REASON.DISPUTE:
      return "Payment disputed (chargeback)";
    default:
      return "Revoked";
  }
}

/**
 * A seat the money side took back for good (refund / cancellation): it is not
 * re-issued by a later orders/paid, and restoring it needs a confirmation.
 * A DISPUTE is deliberately NOT one of these: the seat still counts as issued
 * (so a re-sync can't mint a replacement), it is only suspended.
 */
export function isMoneyRevocation(reason: string | null | undefined): boolean {
  return reason === REVOKE_REASON.REFUND || reason === REVOKE_REASON.CANCELLED;
}

/** Revoked because of the payment (refund, cancellation, open chargeback): restoring asks for confirmation. */
export function isPaymentRevocation(reason: string | null | undefined): boolean {
  return isMoneyRevocation(reason) || reason === REVOKE_REASON.DISPUTE;
}
