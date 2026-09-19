import { data } from "react-router";

/**
 * Small in-memory sliding-window rate limiter for the auth endpoints.
 *
 * Good enough for a single-process deployment (this app runs one Node
 * server). If the app is ever scaled to several instances, swap the Map for
 * Redis - the call sites stay the same.
 *
 * Two independent buckets per endpoint:
 *  - subject (email / licence key): the thing under attack. An attacker
 *    can't rotate it without changing target, so it's the reliable limit.
 *  - client IP: only meaningful behind a trusted proxy (TRUST_PROXY=true) and
 *    deliberately generous, so a classroom or office NAT isn't locked out.
 *
 * Login / redeem / reset count FAILED attempts only (call `recordFailure`),
 * so successful sign-ins never eat into the budget. Register and
 * forgot-password count every submission.
 */

type Bucket = number[]; // timestamps (ms) of recent hits

const buckets = new Map<string, Bucket>();

export const LIMITS = {
  login: { ip: 40, subject: 10, windowMs: 15 * 60_000 },
  register: { ip: 20, subject: 5, windowMs: 60 * 60_000 },
  forgot_password: { ip: 15, subject: 3, windowMs: 60 * 60_000 },
  reset_password: { ip: 30, subject: 10, windowMs: 15 * 60_000 },
  redeem: { ip: 40, subject: 10, windowMs: 15 * 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

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

/**
 * Best-effort client address. Each trusted reverse proxy APPENDS one hop to
 * X-Forwarded-For, so with N trusted proxies the client is the N-th hop from
 * the end (everything before that is client-controlled and never used).
 *   TRUST_PROXY=true            -> one proxy (Plesk/nginx/Docker)
 *   TRUST_PROXY_HOPS=2          -> e.g. Cloudflare -> nginx -> app
 * Without a proxy the header is entirely client-controlled and is ignored.
 */
export function clientIp(request: Request): string {
  const hopsEnv = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  const trusted = Number.isInteger(hopsEnv) && hopsEnv > 0
    ? hopsEnv
    : process.env.TRUST_PROXY === "true" ? 1 : 0;
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

function keysFor(name: LimitName, request: Request, subject?: string): Array<[string, number]> {
  const lim = LIMITS[name];
  const ip = clientIp(request);
  const keys: Array<[string, number]> = [];
  if (ip !== "unknown") keys.push([`${name}:ip:${ip}`, lim.ip]);
  if (subject) keys.push([`${name}:subject:${subject.trim().toLowerCase()}`, lim.subject]);
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
    return data(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429 },
    );
  }
  return null;
}
