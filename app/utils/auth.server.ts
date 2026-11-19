import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { parse, serialize } from "cookie";
import crypto, { randomUUID } from "crypto";
import { prisma } from "./db.server";
import { clientIp, isProxyTrusted } from "./rate-limit.server";
import { redirect } from "react-router";

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set (>= 16 chars) in production.");
  }
  console.warn("[auth] JWT_SECRET missing - using an insecure development secret.");
  return "dev-secret-change-in-production";
})();
const COOKIE_NAME = "lms_session";
const SESSION_DURATION_DAYS = 7; // inactivity window (slides on activity)
const SESSION_MAX_DAYS = 30; // hard ceiling for the JWT / cookie

/** Shape of the user object attached to a request session (safe to send to the client). */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  isBanned: boolean;
  isSuspended: boolean;
};

// ─── Password helpers ─────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * A genuine bcrypt hash used when a login names an unknown email: comparing
 * against it costs the same ~250 ms as a real check, so response time no
 * longer reveals whether an account exists.
 */
export const DUMMY_HASH: string = bcrypt.hashSync("not-a-real-password", 12);

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
    expiresIn: `${SESSION_MAX_DAYS}d`,
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

// COOKIE_SECURE env var controls the Secure flag:
// - "true"  → secure cookies (HTTPS only)
// - "false" → insecure cookies (only for local HTTP development)
// - unset   → secure in production, insecure otherwise
const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production";

export function createSessionCookie(token: string): string {
  return serialize(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * SESSION_MAX_DAYS, // hard ceiling; DB expiresAt slides with activity
    path: "/",
  });
}

export function clearSessionCookie(): string {
  return serialize(COOKIE_NAME, "", {
    httpOnly: true,
    secure: COOKIE_SECURE,
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

/** SHA-256 of the current request's session token (how sessions are stored), or null. */
export function getCurrentSessionTokenHash(request: Request): string | null {
  const token = getTokenFromRequest(request);
  return token ? hashToken(token) : null;
}

// ─── Device info extraction ───────────────────────────────────────────────────

export function getDeviceInfo(request: Request): {
  ipAddress: string;
  userAgent: string;
  deviceId: string;
  /** False when the IP is client-supplied (no TRUST_PROXY): display only. */
  ipTrusted: boolean;
} {
  const userAgent = request.headers.get("user-agent") || "unknown";
  // The client can write anything into the LEFT of X-Forwarded-For; only the
  // hop our own proxy appended is real, and clientIp knows which one that is.
  // Without a trusted proxy nothing is reliable, so keep a best guess for the
  // /sessions page.
  const ipTrusted = isProxyTrusted();
  const ipAddress = ipTrusted
    ? clientIp(request)
    : request.headers.get("x-real-ip")?.trim() ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
  // Create a deterministic device ID from UA + IP (simplified fingerprint)
  const deviceId = crypto
    .createHash("sha256")
    .update(`${userAgent}|${ipAddress}`)
    .digest("hex")
    .substring(0, 16);

  return { ipAddress, userAgent, deviceId, ipTrusted };
}

// ─── Session management ────────────────────────────────────────────────────────

/**
 * Creates a new session in DB, ending the user's least recently used
 * sessions when they are over their device limit (User.maxDevices).
 */
export async function createSession(
  userId: string,
  role: string,
  request: Request,
): Promise<string> {
  const { ipAddress, userAgent, deviceId, ipTrusted } = getDeviceInfo(request);

  // Times are bound from the app clock, never NOW(): the columns are
  // TIMESTAMP without a zone holding UTC (that's how Prisma writes them), and
  // NOW() is read in the database session's TimeZone, which is only UTC by
  // default. getSessionState also decides "expired" with the app clock.
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // Generate session ID upfront so we can embed it in the JWT
  const sessionId = randomUUID();
  const token = signToken({ userId, role, sessionId });
  const tokenHash = hashToken(token);

  // Read limit -> evict oldest -> insert, all inside one transaction with the
  // user row locked, so two simultaneous logins can't both squeeze past the
  // device limit, and a failed insert can't leave the user with no session.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ maxDevices: number }>>`
      SELECT "maxDevices" FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
    const limit = rows[0]?.maxDevices ?? 1;

    if (limit > 0) {
      // Oldest sessions first; keep (limit - 1) so the new one fits. With a
      // trusted IP, sessions from this same device (cookie lost, private
      // window) go first, so signing in again here doesn't sign out the
      // learner's other device. An untrusted IP makes deviceId meaningless.
      // COALESCE: rows saved without a deviceId count as another device.
      // Expired rows can never be used again, so they neither take a slot nor
      // get evicted ahead of a live session. They stay isActive, so that
      // browser is still told "expired" rather than "ended".
      const activeSessions = ipTrusted
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "UserSession"
            WHERE "userId" = ${userId} AND "isActive" = true AND "expiresAt" > ${now}
            ORDER BY COALESCE("deviceId" = ${deviceId}, false) DESC, "lastActiveAt" ASC
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "UserSession"
            WHERE "userId" = ${userId} AND "isActive" = true AND "expiresAt" > ${now}
            ORDER BY "lastActiveAt" ASC
          `;
      const excess = activeSessions.length - limit + 1;
      if (excess > 0) {
        const ids = activeSessions.slice(0, excess).map((s) => s.id);
        await tx.userSession.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
      }
    }

    await tx.$executeRaw`
      INSERT INTO "UserSession" (id, "userId", token, "deviceId", "ipAddress", "userAgent", "isActive", "expiresAt", "lastActiveAt", "createdAt")
      VALUES (${sessionId}, ${userId}, ${tokenHash}, ${deviceId}, ${ipAddress}, ${userAgent}, true, ${expiresAt}, ${now}, ${now})
    `;
  });

  return token;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

/**
 * What the request's session cookie amounts to. "ended" = the session was
 * switched off (device limit, admin force logout, password changed on another
 * device); "expired" = it timed out from inactivity. Kept apart so the login
 * page can tell the learner why they were signed out.
 */
export type SessionState =
  | { status: "ok"; user: SessionUser }
  | { status: "none" }
  | { status: "invalid" }
  | { status: "ended" }
  | { status: "expired" }
  | { status: "blocked" };

export async function getSessionState(request: Request): Promise<SessionState> {
  const token = getTokenFromRequest(request);
  if (!token) return { status: "none" };

  const payload = verifyToken(token);
  if (!payload || typeof payload.sessionId !== "string" || typeof payload.userId !== "string") {
    return { status: "invalid" };
  }

  const tokenHash = hashToken(token);

  const sessions = await prisma.$queryRaw<Array<{ id: string; lastActiveAt: Date; isActive: boolean; expiresAt: Date }>>`
    SELECT id, "lastActiveAt", "isActive", "expiresAt" FROM "UserSession"
    WHERE id = ${payload.sessionId} AND token = ${tokenHash}
  `;
  const session = sessions[0];
  if (!session) return { status: "invalid" };
  if (!session.isActive) return { status: "ended" };
  if (new Date(session.expiresAt) <= new Date()) return { status: "expired" };

  // NOTE: never select "passwordHash" here — this object is returned from
  // loaders and serialized into the HTML sent to the browser.
  const users = await prisma.$queryRaw<SessionUser[]>`
    SELECT id, email, name, role, "isBanned", "isSuspended"
    FROM "User" WHERE id = ${payload.userId} LIMIT 1
  `;
  const user = users[0];
  if (!user) return { status: "invalid" };

  // Block banned/suspended users
  if (user.isBanned || user.isSuspended) return { status: "blocked" };

  // Sliding expiry: activity pushes the DB expiry out again (debounced to
  // one write per 5 minutes). The JWT/cookie carry a longer hard ceiling so a
  // daily-active learner is no longer logged out mid-lesson on day 7.
  // App-clock times, not NOW() - see createSession.
  const nowMs = Date.now();
  const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000);
  if (session.lastActiveAt < fiveMinutesAgo) {
    const touchedAt = new Date(nowMs);
    const slidTo = new Date(nowMs + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);
    prisma.$executeRaw`
      UPDATE "UserSession"
      SET "lastActiveAt" = ${touchedAt},
          "expiresAt" = ${slidTo}
      WHERE id = ${session.id}
    `.catch(() => {}); // Non-critical
  }

  return { status: "ok", user };
}

/** The signed-in user, or null when there is no usable session. */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const state = await getSessionState(request);
  return state.status === "ok" ? state.user : null;
}

export async function invalidateSession(request: Request): Promise<void> {
  const token = getTokenFromRequest(request);
  if (!token) return;

  const payload = verifyToken(token);
  if (!payload) return;

  const tokenHash = hashToken(token);
  await prisma.$executeRaw`UPDATE "UserSession" SET "isActive" = false WHERE token = ${tokenHash}`
    .catch(() => {});
}

export type RequireUserOptions = {
  /**
   * Where sign-in returns to instead of the current page; null = nowhere (the
   * role's default landing). For routes that answer with a file: a sign-in
   * that ends in a download never leaves the login page, which then sits on
   * "Signing in…" for good.
   */
  returnTo?: string | null;
};

/**
 * The signed-in user, or a redirect to the login page that says why the
 * session ended and, for a page load, brings the learner back to it (or to
 * opts.returnTo) after signing in.
 */
export async function requireUser(request: Request, opts?: RequireUserOptions): Promise<SessionUser> {
  const state = await getSessionState(request);
  if (state.status === "ok") return state.user;

  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");
  const params = new URLSearchParams();
  if (state.status === "ended" || state.status === "expired") {
    params.set("signedOut", state.status);
  }
  // Only a GET page can be resumed (a POST body is gone after the redirect).
  // Plain "/" is left out: the role default, with its welcome toast, is the
  // better landing there.
  const returnTo = opts?.returnTo === undefined ? url.pathname + url.search : opts.returnTo;
  if (returnTo && returnTo !== "/" && request.method === "GET" && !isApi && !url.pathname.startsWith("/auth/")) {
    params.set("redirect", returnTo);
  }
  const query = params.toString();
  const location = query ? `/auth/login?${query}` : "/auth/login";

  // Drop the dead cookie. Not on /api/ calls (video segments): the learner
  // never sees those redirects, and clearing the cookie there would make the
  // next page load look like "never signed in" and lose the reason above.
  if (state.status === "none" || isApi) throw redirect(location);
  throw redirect(location, { headers: { "Set-Cookie": clearSessionCookie() } });
}

/** requireUser for admin pages; anyone else goes to /student. opts as for requireUser. */
export async function requireAdmin(request: Request, opts?: RequireUserOptions) {
  const user = await requireUser(request, opts);
  if (user.role !== "ADMIN") {
    throw redirect("/student");
  }
  return user;
}

// ─── Derived secrets ───────────────────────────────────────────────────────────

/**
 * A purpose-specific key derived from JWT_SECRET, for HMAC-signing things that
 * are not sessions (e.g. video-proxy URLs). A distinct label per purpose means
 * a signature minted for one feature can never be replayed against another.
 */
export function deriveSecret(label: string): Buffer {
  return crypto.createHmac("sha256", JWT_SECRET).update(`lms:${label}`).digest();
}

// ─── License key generation ────────────────────────────────────────────────────

/**
 * No 0/O, 1/I/L: keys are printed on paper and typed by hand, and those pairs
 * are the usual "Invalid license key" support ticket. 31 symbols x 12
 * positions is still ~59 bits. Keys minted before this change may contain the
 * ambiguous characters; the redeem lookup tolerates them (license.server.ts).
 */
export const LICENSE_KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateLicenseKey(): string {
  const chars = LICENSE_KEY_ALPHABET;
  const segment = (len: number) =>
    Array.from({ length: len }, () =>
      chars.charAt(crypto.randomInt(chars.length)),
    ).join("");
  return `LIC-${segment(4)}-${segment(4)}-${segment(4)}`;
}
