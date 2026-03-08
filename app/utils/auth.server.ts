import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { parse, serialize } from "cookie";
import crypto from "crypto";
import { prisma } from "./db.server";
import { redirect } from "react-router";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const COOKIE_NAME = "lms_session";
const SESSION_DURATION_DAYS = 7;

// ─── Password helpers ─────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

export function signToken(payload: {
  userId: string;
  role: string;
  sessionId: string;
}): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: `${SESSION_DURATION_DAYS}d`,
  });
}

export function verifyToken(
  token: string,
): { userId: string; role: string; sessionId: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as {
      userId: string;
      role: string;
      sessionId: string;
    };
  } catch {
    return null;
  }
}

// ─── Token hash (for storage — never store raw JWT) ───────────────────────────

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

export function createSessionCookie(token: string): string {
  return serialize(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * SESSION_DURATION_DAYS,
    path: "/",
  });
}

export function clearSessionCookie(): string {
  return serialize(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}

function getTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  return cookies[COOKIE_NAME] || null;
}

// ─── Device info extraction ───────────────────────────────────────────────────

export function getDeviceInfo(request: Request): {
  ipAddress: string;
  userAgent: string;
  deviceId: string;
} {
  const userAgent = request.headers.get("user-agent") || "unknown";
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  // Create a deterministic device ID from UA + IP (simplified fingerprint)
  const deviceId = crypto
    .createHash("sha256")
    .update(`${userAgent}|${ipAddress}`)
    .digest("hex")
    .substring(0, 16);

  return { ipAddress, userAgent, deviceId };
}

// ─── Session management ────────────────────────────────────────────────────────

/**
 * Creates a new session in DB, invalidating all previous sessions for the
 * same user (single-device enforcement).
 */
export async function createSession(
  userId: string,
  role: string,
  request: Request,
): Promise<string> {
  const { ipAddress, userAgent, deviceId } = getDeviceInfo(request);

  // Use $queryRaw to avoid stale Prisma client type validation issues
  const rows = await prisma.$queryRaw<Array<{ maxDevices: number }>>`
    SELECT "maxDevices" FROM "User" WHERE id = ${userId}
  `;
  const limit = rows[0]?.maxDevices ?? 1;

  // Get active sessions for the user, ordered by lastActiveAt ascending (oldest first)
  const activeSessions = await prisma.userSession.findMany({
    where: { userId, isActive: true },
    orderBy: { lastActiveAt: "asc" },
  });

  // If we are about to exceed the limit, invalidate the oldest sessions
  // We want to leave exactly (limit - 1) active sessions before adding the new one.
  if (limit > 0 && activeSessions.length >= limit) {
    const sessionsToInvalidate = activeSessions.length - limit + 1;
    const idsToInvalidate = activeSessions
      .slice(0, sessionsToInvalidate)
      .map((s) => s.id);

    await prisma.userSession.updateMany({
      where: { id: { in: idsToInvalidate } },
      data: { isActive: false },
    });
  }

  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // Create placeholder session to get its ID
  const session = await prisma.userSession.create({
    data: {
      userId,
      token: "pending",
      deviceId,
      ipAddress,
      userAgent,
      isActive: true,
      expiresAt,
      lastActiveAt: new Date(),
    },
  });

  // Now sign token with the session ID
  const token = signToken({ userId, role, sessionId: session.id });
  const tokenHash = hashToken(token);

  // Store the hash (not the raw JWT)
  await prisma.userSession.update({
    where: { id: session.id },
    data: { token: tokenHash },
  });

  return token;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export async function getSessionUser(request: Request) {
  const token = getTokenFromRequest(request);
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  const tokenHash = hashToken(token);

  // Validate session exists, is active, and not expired
  const session = await prisma.userSession.findFirst({
    where: {
      id: payload.sessionId,
      token: tokenHash,
      isActive: true,
      expiresAt: { gt: new Date() },
    },
  });

  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) return null;

  // Block banned/suspended users
  if (user.isBanned || user.isSuspended) return null;

  // Update last active timestamp (debounced — only update every 5 minutes)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  if (session.lastActiveAt < fiveMinutesAgo) {
    await prisma.userSession
      .update({
        where: { id: session.id },
        data: { lastActiveAt: new Date() },
      })
      .catch(() => {}); // Non-critical
  }

  return user;
}

export async function invalidateSession(request: Request): Promise<void> {
  const token = getTokenFromRequest(request);
  if (!token) return;

  const payload = verifyToken(token);
  if (!payload) return;

  const tokenHash = hashToken(token);
  await prisma.userSession
    .updateMany({
      where: { token: tokenHash },
      data: { isActive: false },
    })
    .catch(() => {});
}

export async function requireUser(request: Request) {
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect("/auth/login");
  }
  return user;
}

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "ADMIN") {
    throw redirect("/student");
  }
  return user;
}

// ─── License key generation ────────────────────────────────────────────────────

export function generateLicenseKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = (len: number) =>
    Array.from({ length: len }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length)),
    ).join("");
  return `LIC-${segment(4)}-${segment(4)}-${segment(4)}`;
}
