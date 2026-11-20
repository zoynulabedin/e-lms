import crypto from "crypto";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { parse, serialize } from "cookie";
import { prisma } from "./db.server";
import { deriveSecret, hashToken } from "./auth.server";
import { describeUserAgent } from "./user-agent";

/**
 * Sign-in security beyond the password:
 *
 *  - TOTP two-step verification (RFC 6238: 30-second steps, 6 digits, SHA-1 -
 *    what Google Authenticator, Microsoft Authenticator, 1Password etc. use).
 *    Required for admins, optional for learners. The secret is stored
 *    AES-256-GCM encrypted with a key derived from JWT_SECRET; a code is
 *    accepted for the current step +/- one (about a minute), and never twice
 *    (User.mfaLastStep).
 *  - One-time recovery codes for a lost authenticator (hash only).
 *  - The "pending sign-in" cookie: after a correct password the browser holds a
 *    5-minute signed token naming the user and the step still missing, so the
 *    password is never asked twice and no session exists until the step passes.
 *  - Trusted devices: a browser that passed a second step keeps a long-lived
 *    random token (cookie); only its hash is stored. A learner signing in from a
 *    browser without one must enter a code emailed to them (new-device check).
 */

// ─── TOTP ────────────────────────────────────────────────────────────────────

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = "Teach Me Like a Tot";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * The time step a code is valid for (current step +/- 1), or null. A code for a
 * step at or before `lastStep` is rejected: each code works once.
 */
export function matchTotp(secretB32: string, code: string, lastStep: number | null): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const now = currentStep();
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = totpCode(secretB32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, accountEmail: string): string {
  const label = encodeURIComponent(`${ISSUER}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 1, width: 200, errorCorrectionLevel: "M" });
}

/** The secret in a human-typable form, for apps without a camera: "ABCD EFGH ..." */
export const formatSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

// ─── Secret encryption at rest ───────────────────────────────────────────────

const ENC_KEY = () => deriveSecret("mfa-secret"); // 32 bytes

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string | null {
  try {
    const [v, iv, tag, enc] = stored.split(":");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ─── Recovery codes ──────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const recoveryHash = (code: string) =>
  crypto.createHmac("sha256", deriveSecret("mfa-recovery")).update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

/** Ten fresh codes ("XXXXX-XXXXX"); replaces any previous set. Returns the plain codes to show ONCE. */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => {
    const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${pick()}-${pick()}`;
  });
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(c) })) }),
  ]);
  return codes;
}

/** Uses up a recovery code; true when it was valid and unused. */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const r = await prisma.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: recoveryHash(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return r.count === 1;
}

/**
 * Checks an authenticator code against the user's stored secret and records
 * the step, so the same code can't be used again (also not by a parallel
 * request: the update is conditional on the previous step).
 */
export async function verifyUserTotp(userId: string, code: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaSecret: true, mfaLastStep: true } });
  if (!user?.mfaSecret) return false;
  const secret = decryptSecret(user.mfaSecret);
  if (!secret) return false;
  const step = matchTotp(secret, code, user.mfaLastStep);
  if (step === null) return false;
  const r = await prisma.user.updateMany({
    where: { id: userId, mfaLastStep: user.mfaLastStep },
    data: { mfaLastStep: step },
  });
  return r.count === 1;
}

export async function disableMfa(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
  ]);
}

// ─── Pending sign-in (between the password and the second step) ──────────────

export type PendingPurpose = "mfa" | "mfa_setup" | "new_device";
export type PendingLogin = { userId: string; purpose: PendingPurpose; redirectTo: string };

const PENDING_COOKIE = "lms_pending";
const PENDING_MINUTES = 10;
const pendingKey = () => deriveSecret("pending-login");

const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";

export function createPendingCookie(p: PendingLogin): string {
  const token = jwt.sign({ uid: p.userId, pur: p.purpose, to: p.redirectTo }, pendingKey(), {
    expiresIn: `${PENDING_MINUTES}m`,
  });
  return serialize(PENDING_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: PENDING_MINUTES * 60,
  });
}

export function clearPendingCookie(): string {
  return serialize(PENDING_COOKIE, "", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/", maxAge: 0 });
}

export function readPending(request: Request): PendingLogin | null {
  const raw = parse(request.headers.get("Cookie") || "")[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, pendingKey()) as { uid?: unknown; pur?: unknown; to?: unknown };
    if (typeof p.uid !== "string") return null;
    if (p.pur !== "mfa" && p.pur !== "mfa_setup" && p.pur !== "new_device") return null;
    return { userId: p.uid, purpose: p.pur, redirectTo: typeof p.to === "string" ? p.to : "" };
  } catch {
    return null;
  }
}

// ─── Trusted devices (new-device verification) ───────────────────────────────

const DEVICE_COOKIE = "lms_device";
const DEVICE_DAYS = 365;

/** Whether learners must confirm a new browser with an emailed code. Off when email can't be sent. */
export function newDeviceCheckEnabled(): boolean {
  if (process.env.NEW_DEVICE_VERIFICATION === "false") return false;
  return !!process.env.RESEND_API_KEY || process.env.NEW_DEVICE_VERIFICATION === "true";
}

/** True when this browser carries a trusted-device token for this user (and refreshes it). */
export async function isTrustedDevice(request: Request, userId: string): Promise<boolean> {
  const raw = parse(request.headers.get("Cookie") || "")[DEVICE_COOKIE];
  if (!raw) return false;
  const row = await prisma.trustedDevice.findUnique({ where: { tokenHash: hashToken(raw) }, select: { id: true, userId: true } });
  if (!row || row.userId !== userId) return false;
  await prisma.trustedDevice.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return true;
}

/** Marks this browser as trusted for the user; returns the Set-Cookie header. */
export async function trustThisDevice(request: Request, userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const ua = request.headers.get("user-agent") || "";
  await prisma.trustedDevice.create({ data: { userId, tokenHash: hashToken(raw), label: describeUserAgent(ua) } });
  return serialize(DEVICE_COOKIE, raw, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_DAYS * 24 * 60 * 60,
  });
}

// ─── Emailed one-time codes / links ──────────────────────────────────────────

export const NEW_DEVICE_MINUTES = 10;
export const RELEASE_MINUTES = 30;
const MAX_CODE_ATTEMPTS = 5;

/** A fresh 6-digit new-device code for the user (older unused ones stop working). */
export async function issueNewDeviceCode(userId: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.$transaction([
    prisma.authToken.updateMany({ where: { userId, purpose: "NEW_DEVICE", usedAt: null }, data: { usedAt: new Date() } }),
    prisma.authToken.create({
      data: {
        userId,
        purpose: "NEW_DEVICE",
        tokenHash: hashToken(`${userId}:${code}`),
        expiresAt: new Date(Date.now() + NEW_DEVICE_MINUTES * 60 * 1000),
      },
    }),
  ]);
  return code;
}

/** Checks a new-device code: wrong guesses are counted, 5 kill the code. */
export async function consumeNewDeviceCode(userId: string, code: string): Promise<"ok" | "wrong" | "expired"> {
  const token = await prisma.authToken.findFirst({
    where: { userId, purpose: "NEW_DEVICE", usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, tokenHash: true, expiresAt: true, attempts: true },
  });
  if (!token || token.expiresAt < new Date() || token.attempts >= MAX_CODE_ATTEMPTS) return "expired";
  const clean = code.replace(/\s+/g, "");
  if (token.tokenHash !== hashToken(`${userId}:${clean}`)) {
    await prisma.authToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
    return "wrong";
  }
  const r = await prisma.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
  return r.count === 1 ? "ok" : "expired";
}

/** A one-time "sign out my other devices" link token. */
export async function issueReleaseToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  await prisma.authToken.create({
    data: { userId, purpose: "RELEASE_DEVICES", tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + RELEASE_MINUTES * 60 * 1000) },
  });
  return raw;
}

/** The user a release token belongs to, if it is valid and unused (does not consume it). */
export async function peekReleaseToken(raw: string): Promise<{ id: string; userId: string } | null> {
  if (!raw) return null;
  const t = await prisma.authToken.findFirst({
    where: { tokenHash: hashToken(raw), purpose: "RELEASE_DEVICES", usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userId: true },
  });
  return t;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export { describeUserAgent } from "./user-agent";
