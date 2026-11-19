import type { Prisma } from "@prisma/client";
import { prisma } from "./db.server";
import { normalizeLicenseKey, type RevokeReason } from "./license";

/**
 * Shared licence helpers for the server. One implementation of "who already
 * holds this course" and "make the enrolment exist", so redeem, the admin
 * grant/restore actions and the Shopify webhook can't drift apart.
 */

type Tx = Prisma.TransactionClient;

const CANONICAL_KEY = /^LIC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Resolves what a learner typed to the STORED key string, or null.
 *
 * Exact match first (after normalizeLicenseKey). Keys minted before the
 * unambiguous alphabet can contain 0/O and 1/I/L, which people mistype from
 * paper, so a miss is retried with those characters folded together - but a
 * fuzzy hit is only accepted when it is unique, so it can never pick between
 * two real keys.
 */
export async function resolveLicenseKey(raw: unknown): Promise<string | null> {
  const key = normalizeLicenseKey(raw);
  if (!key) return null;

  const exact = await prisma.license.findUnique({ where: { key }, select: { key: true } });
  if (exact) return exact.key;
  if (!CANONICAL_KEY.test(key)) return null;

  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    SELECT key FROM "License"
    WHERE translate(key, 'OIL', '011') = translate(${key}, 'OIL', '011')
    LIMIT 2
  `;
  return rows.length === 1 ? rows[0].key : null;
}

/**
 * Inside a transaction: locks the user row, then returns an ACTIVE licence the
 * user already holds for the course (other than `exceptLicenseId`), or null.
 *
 * The row lock serialises every "give this user the course" path for the same
 * user, so two keys for one course redeemed at the same moment cannot both
 * succeed - the second sees the first and is refused instead of burning a key.
 */
export async function lockUserAndFindActiveLicense(
  tx: Tx,
  userId: string,
  courseId: string,
  exceptLicenseId?: string,
): Promise<{ id: string; key: string } | null> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  return tx.license.findFirst({
    where: {
      userId,
      courseId,
      status: "ACTIVE",
      ...(exceptLicenseId ? { NOT: { id: exceptLicenseId } } : {}),
    },
    select: { id: true, key: true },
  });
}

/** Enrollment + Progress rows that redeeming a key has always created (bookkeeping only; access is the licence). */
export async function ensureEnrollment(tx: Tx, userId: string, courseId: string): Promise<void> {
  await tx.enrollment.upsert({
    where: { userId_courseId: { userId, courseId } },
    update: {},
    create: { userId, courseId },
  });
  await tx.progress.upsert({
    where: { userId_courseId: { userId, courseId } },
    update: {},
    create: { userId, courseId },
  });
}

/** The `data` for revoking a licence, with the reason recorded. */
export function revokedFields(reason: RevokeReason) {
  return { status: "REVOKED" as const, revokedAt: new Date(), revokedReason: reason };
}
