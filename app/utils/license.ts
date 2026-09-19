/**
 * Bulk-generated keys have no buyer yet; this sentinel marks that state so
 * the redeem form doesn't pre-fill it and "Resend Email" refuses to mail it.
 * One definition, used by licenses.tsx and redeem.tsx.
 */
export const PLACEHOLDER_EMAIL = "unassigned@placeholder.com";

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const e = email.toLowerCase();
  return e === PLACEHOLDER_EMAIL || e === "pending@customer.com" || e.endsWith("@placeholder.com");
}
