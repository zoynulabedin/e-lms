import { createHash } from "crypto";
import { data } from "react-router";

/**
 * Small in-memory sliding-window rate limiter for the auth endpoints.
 *
 * Good enough for a single-process deployment (this app runs one Node
 * server). If the app is ever scaled to several instances, swap the Map for
 * Redis - the call sites stay the same.
 *
 * Two independent buckets per endpoint:
 *  - subject (email / licence key / user id): the thing under attack. An attacker
 *    can't rotate it without changing target, so it's the reliable limit.
 *  - client IP: only meaningful behind a trusted proxy (TRUST_PROXY=true) and
 *    deliberately generous, so a classroom or office NAT isn't locked out.
 *
 * Login / redeem / reset / account_password count FAILED attempts only (call
 * `recordFailure`), so successful sign-ins never eat into the budget. Register
 * and forgot-password count every submission.
 */

type Bucket = number[]; // timestamps (ms) of recent hits

const buckets = new Map<string, Bucket>();

export const LIMITS = {
  login: { ip: 40, subject: 10, windowMs: 15 * 60_000 },
  register: { ip: 20, subject: 5, windowMs: 60 * 60_000 },
  forgot_password: { ip: 15, subject: 3, windowMs: 60 * 60_000 },
  reset_password: { ip: 30, subject: 10, windowMs: 15 * 60_000 },
  redeem: { ip: 40, subject: 10, windowMs: 15 * 60_000 },
  // Key LOOKUPS on the /redeem page (GET), per IP only. Separate and generous:
  // a school redeeming paper keys from one public IP makes many honest typos,
  // and must not lock itself out of redeeming. Guessing a key stays hopeless
  // (~59 bits) even at this rate.
  redeem_lookup: { ip: 200, subject: 200, windowMs: 15 * 60_000 },
  // Current-password checks on /student/settings, keyed by user id: a
  // signed-in session must not become an unlimited password-guessing oracle.
  account_password: { ip: 30, subject: 5, windowMs: 15 * 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

/** The 429 message; exported for call sites that build their own response body. */
export const TOO_MANY_ATTEMPTS = "Too many attempts. Please wait a few minutes and try again.";

// Opportunistic cleanup so the map can't grow without bound. Each bucket is
// pruned with ITS OWN window (a login sweep must not shorten the 1-hour
// forgot-password window).
let lastSweep = Date.now();
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, hits] of buckets) {
    const name = k.slice(0, k.indexOf(":")) as LimitName;
    const windowMs = LIMITS[name]?.windowMs ?? 60 * 60_000;
    const fresh = hits.filter((t) => now - t < windowMs);
    if (fresh.length) buckets.set(k, fresh);
    else buckets.delete(k);
  }
}

/** Number of trusted reverse proxies in front of the app (0 = none). */
function trustedHops(): number {
  const hopsEnv = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  if (Number.isInteger(hopsEnv) && hopsEnv > 0) return hopsEnv;
  return process.env.TRUST_PROXY === "true" ? 1 : 0;
}

/** True when X-Forwarded-For comes from a proxy we trust (see clientIp). */
export function isProxyTrusted(): boolean {
  return trustedHops() > 0;
}

// Without a trusted proxy every request's IP is "unknown", so the per-IP
// buckets silently never fill. Say so once, on first use (importing stays
// quiet) - also when the variable is set to a value that doesn't count, such
// as "1" or "TRUE". TRUST_PROXY=false is a deliberate opt-out and stays quiet.
let proxyWarningDone = false;
function warnOnceIfProxyUntrusted() {
  if (proxyWarningDone) return;
  proxyWarningDone = true;
  if (
    process.env.NODE_ENV === "production" &&
    trustedHops() === 0 &&
    process.env.TRUST_PROXY !== "false"
  ) {
    const found = [
      process.env.TRUST_PROXY ? `TRUST_PROXY is ${JSON.stringify(process.env.TRUST_PROXY)}` : "",
      process.env.TRUST_PROXY_HOPS ? `TRUST_PROXY_HOPS is ${JSON.stringify(process.env.TRUST_PROXY_HOPS)}` : "",
    ].filter(Boolean).join(", ") || "TRUST_PROXY is not set";
    console.warn(
      `[rate-limit] ${found} (only TRUST_PROXY="true", or TRUST_PROXY_HOPS >= 1, enable it) - per-IP limits on login/register/redeem are OFF. Set TRUST_PROXY=true when the app runs behind Plesk/nginx (see PLESK_DEPLOYMENT.md), or TRUST_PROXY=false to silence this when no proxy is in front.`,
    );
  }
}

/**
 * Best-effort client address. Each trusted reverse proxy APPENDS one hop to
 * X-Forwarded-For, so with N trusted proxies the client is the N-th hop from
 * the end (everything before that is client-controlled and never used).
 *   TRUST_PROXY=true            -> one proxy (Plesk/nginx/Docker)
 *   TRUST_PROXY_HOPS=2          -> e.g. Cloudflare -> nginx -> app
 * Without a proxy the header is entirely client-controlled and is ignored.
 */
export function clientIp(request: Request): string {
  warnOnceIfProxyUntrusted();
  const trusted = trustedHops();
  if (trusted > 0) {
    const xf = request.headers.get("x-forwarded-for");
    if (xf) {
      const hops = xf.split(",").map((s) => s.trim()).filter(Boolean);
      const idx = hops.length - trusted;
      if (idx >= 0) return hops[idx];
      if (hops.length) return hops[0];
    }
    const real = request.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "unknown";
}

// Subjects are form input and live on as Map keys until swept: a long one
// (a megabyte "email") is stored as its hash, so no key outgrows this.
// Distinct values still get distinct buckets.
const MAX_SUBJECT_LENGTH = 200;

function subjectKey(subject: string): string {
  const s = subject.trim().toLowerCase();
  return s.length > MAX_SUBJECT_LENGTH ? `sha256:${createHash("sha256").update(s).digest("hex")}` : s;
}

function keysFor(name: LimitName, request: Request, subject?: string): Array<[string, number]> {
  const lim = LIMITS[name];
  const ip = clientIp(request);
  const keys: Array<[string, number]> = [];
  if (ip !== "unknown") keys.push([`${name}:ip:${ip}`, lim.ip]);
  if (subject) keys.push([`${name}:subject:${subjectKey(subject)}`, lim.subject]);
  return keys;
}

function recentHits(id: string, windowMs: number, now: number): Bucket {
  return (buckets.get(id) ?? []).filter((t) => now - t < windowMs);
}

/** Records one hit against every bucket for this request (no limit check). */
export function recordAttempt(name: LimitName, request: Request, subject?: string) {
  const now = Date.now();
  sweep(now);
  for (const [id] of keysFor(name, request, subject)) {
    const hits = recentHits(id, LIMITS[name].windowMs, now);
    hits.push(now);
    buckets.set(id, hits);
  }
}

/** Alias that reads better at call sites which only count failures. */
export const recordFailure = recordAttempt;

/**
 * Returns a 429 `data()` response when the caller is over the limit, else
 * null. Pure check - it does NOT record a hit. The caller RETURNS the response
 * so it renders as a normal form error, not in the root ErrorBoundary.
 *
 * Usage patterns:
 *   count every submission:   `const l = rateLimitResponse(...); if (l) return l; recordAttempt(...)`
 *   count failures only:      `const l = rateLimitResponse(...); if (l) return l; ...on failure: recordFailure(...)`
 */
export function rateLimitResponse(name: LimitName, request: Request, subject?: string) {
  const now = Date.now();
  sweep(now);
  const over = keysFor(name, request, subject).some(
    ([id, max]) => recentHits(id, LIMITS[name].windowMs, now).length >= max,
  );
  if (over) {
    return data({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
  }
  return null;
}
