import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { getAccessibleCourseIds } from "./access.server";
import { deriveSecret } from "./auth.server";
import { prisma } from "./db.server";

/**
 * Access control for /api/video-proxy (routes/api.video-proxy.ts).
 *
 * Being signed in is not enough - anyone can register - so:
 *  - the page's first request, the playlist URL of a lesson, course or quiz
 *    answer, must appear in a course the user holds an ACTIVE licence for
 *    (userMayPlay);
 *  - every URL inside that playlist comes back signed for the same user with
 *    an expiry (signProxyPath). The variant playlists, keys and segments that
 *    follow need no database work, and a URL copied out of devtools only works
 *    for that account, and only until it expires.
 */

const SIGNING_KEY = deriveSecret("video-proxy");

/** How long one entitlement check covers a playback. */
const SIGNED_URL_TTL_SECONDS = 12 * 60 * 60;

// HMAC-SHA256 = 32 bytes = 43 base64url characters (no padding).
const SIG_FORMAT = /^[A-Za-z0-9_-]{43}$/;
// Whole seconds without a leading zero, so each signed URL has one valid form.
const EXP_FORMAT = /^[1-9]\d{0,11}$/;

function proxySignature(userId: string, url: string, exp: number): string {
  // A user id (uuid) and exp (digits) never contain a newline, so the joined
  // string can only be read one way.
  return crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(`${userId}\n${exp}\n${url}`)
    .digest("base64url");
}

/**
 * Expiry (unix seconds) for a playback that just passed userMayPlay: 12 hours
 * out, rounded up to the next full hour. A reload within that hour then gets
 * the very same segment URLs, so the browser cache (max-age=3600) still hits.
 */
export function newProxyExpiry(now = Date.now()): number {
  const hour = 60 * 60;
  return Math.ceil((Math.floor(now / 1000) + SIGNED_URL_TTL_SECONDS) / hour) * hour;
}

/** `/api/video-proxy?url=…&exp=…&sig=…`: the proxy URL for `url`, valid for `userId` until `exp` (unix seconds). */
export function signProxyPath(userId: string, url: string, exp: number): string {
  const params = new URLSearchParams({
    url,
    exp: String(exp),
    sig: proxySignature(userId, url, exp),
  });
  return `/api/video-proxy?${params}`;
}

/** True when `sig` was made by signProxyPath for this user and URL, and `exp` has not passed yet. */
export function verifyProxySignature(
  userId: string,
  url: string,
  exp: string | null,
  sig: string | null,
): boolean {
  if (!exp || !sig || !EXP_FORMAT.test(exp) || !SIG_FORMAT.test(sig)) return false;
  const expiry = Number(exp);
  if (expiry <= Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(proxySignature(userId, url, expiry));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * May this user start playing `url`? Admins always may. Anyone else only when
 * the URL appears in a course they hold an ACTIVE licence for: a lesson's
 * video URL or iFrame embed, the course's own video or intro video, or a quiz
 * answer's video.
 *
 * "Appears in" (position() > 0) rather than "equals", because the player
 * takes the URL out of the <iframe> tag pasted into iframeEmbed. NULL columns
 * never match.
 */
export async function userMayPlay(
  user: { id: string; role: string },
  url: string,
): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  // Postgres text cannot hold U+0000 (binding one fails the whole query), so
  // no stored video URL contains it and nothing can match.
  if (url.includes("\u0000")) return false;
  const courseIds = await getAccessibleCourseIds(user.id);
  if (courseIds.length === 0) return false;

  const ids = Prisma.join(courseIds);
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Lesson" l
      JOIN "Module" m ON m.id = l."moduleId"
      WHERE m."courseId" IN (${ids})
        AND (position(${url}::text in l."videoUrl") > 0
          OR position(${url}::text in l."iframeEmbed") > 0)
      UNION ALL
      SELECT 1 FROM "Course" c
      WHERE c.id IN (${ids})
        AND (position(${url}::text in c."videoUrl") > 0
          OR position(${url}::text in c."introVideoUrl") > 0)
      UNION ALL
      SELECT 1 FROM "Answer" a
      JOIN "Question" q ON q.id = a."questionId"
      JOIN "Quiz" z ON z.id = q."quizId"
      JOIN "Module" m ON m.id = z."moduleId"
      WHERE m."courseId" IN (${ids})
        AND position(${url}::text in a."videoUrl") > 0
    ) AS ok
  `;
  return rows[0]?.ok === true;
}
