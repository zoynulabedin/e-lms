import { prisma } from "./db.server";
import {
  CONFIG_FIELDS,
  DEFAULT_CONFIG,
  normalizeConfig,
  type SafeConfig,
} from "./certificate-template";

/**
 * Server-side glue for the certificate template: reading the admin's saved
 * design, and the response headers every certificate HTML response must carry.
 *
 * The renderer itself lives in ./certificate-template.ts and is isomorphic —
 * keep server-only code here, not there.
 */

/** The single global template row. A literal primary key, so the database
 *  structurally cannot hold two of them — a UNIQUE index on a nullable
 *  `courseId` would not, since Postgres permits unlimited NULLs. */
export const GLOBAL_TEMPLATE_ID = "global";

// Built from CONFIG_FIELDS, never hand-listed: a column added to the schema and
// the editor but forgotten here would be written and then never read back, and
// the setting would quietly do nothing. Still an explicit list rather than
// SELECT *, so a later column cannot change the shape normalizeConfig sees.
const COLUMNS = CONFIG_FIELDS.map((f) => `"${f}"`).join(", ");

export type ResolvedTemplate = {
  config: SafeConfig;
  /** false when the admin has never saved — drives the editor's first-run copy. */
  exists: boolean;
  /** false when the table is missing, i.e. the migration has not been deployed. */
  tableReady: boolean;
};

/**
 * Read the saved design, falling back to the built-in defaults.
 *
 * Deliberately $queryRaw rather than the generated client. On this project's
 * Plesk box `prisma generate` and `prisma migrate deploy` are separate steps,
 * so the two can skew in EITHER direction: a client that predates the model
 * (prisma.certificateTemplate is undefined, and calling .findFirst on it throws
 * a SYNCHRONOUS TypeError no .catch() can intercept), or a table that exists
 * while the client is stale. $queryRaw survives both — it is always defined,
 * and a missing table throws asynchronously, which the catch below handles.
 *
 * Column names are listed explicitly so adding a column later cannot silently
 * change the shape handed to normalizeConfig().
 */
export async function resolveCertificateConfig(): Promise<ResolvedTemplate> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM "CertificateTemplate" WHERE id = $1 LIMIT 1`,
      GLOBAL_TEMPLATE_ID,
    );
    const row = rows[0];
    return {
      // normalizeConfig runs on READ, not only on write: a row edited directly
      // in psql, or written by an older save path, still cannot inject into the
      // raw HTML the renderer produces.
      config: normalizeConfig(row ?? DEFAULT_CONFIG),
      exists: !!row,
      tableReady: true,
    };
  } catch (err) {
    console.error(
      "[certificate] template table unavailable (migration not deployed?) —",
      "run `npm run setup` and restart; serving the built-in design meanwhile:",
      err,
    );
    return { config: normalizeConfig(DEFAULT_CONFIG), exists: false, tableReady: false };
  }
}

/**
 * Headers for any response that emits certificate HTML.
 *
 * Certificate routes are resource routes: they return their own Response, so
 * they do NOT inherit the headers() exported by app/root.tsx. Without this
 * helper a certificate response would ship with no CSP at all, which is what
 * the original route did. Route every response that emits certificate HTML
 * through here so no future one can forget.
 *
 * frame-ancestors is 'none' on EVERY certificate response, with no opt-out.
 * The admin editor's live preview does not need an exception: it calls the
 * same renderer in the browser and writes the result into an about:blank
 * iframe, so no server route is ever framed. If you find yourself wanting a
 * frameable variant, render client-side instead — a certificate page that can
 * be embedded is a clickjacking target for no benefit.
 */
export function certificateHeaders(opts: { nonce?: string } = {}): Record<string, string> {
  const { nonce } = opts;

  const csp = [
    "default-src 'none'",
    // Only the print-button listener, and only when a nonce was issued.
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    // The stylesheet is generated entirely from validated enums and
    // /^#[0-9a-fA-F]{6}$/ colours — no admin free text reaches CSS — so
    // 'unsafe-inline' here grants nothing an attacker could use.
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    // Uploaded logos and signatures only. No data: — nothing in the template
    // needs it, and it is the one remaining non-Cloudinary image source.
    "img-src https://res.cloudinary.com",
    "font-src https://fonts.gstatic.com",
    // Stated explicitly rather than left to the default-src fallback.
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    // Names a real person and their achievement; never cached by a proxy and
    // never indexed.
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
