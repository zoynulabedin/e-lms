import type { LoaderFunctionArgs } from "react-router";
import { getSessionUser } from "../utils/auth.server";
import {
  newProxyExpiry,
  signProxyPath,
  userMayPlay,
  verifyProxySignature,
} from "../utils/video-proxy.server";

const ALLOWED_HOST = "courses.instructionalgraphics.org";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function resolveUrl(path: string, base: string): string | null {
  try {
    const abs = new URL(path, base).href;
    return new URL(abs).hostname === ALLOWED_HOST ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Points every URI of a playlist that is on the allowed host back at this
 * proxy, signed for the user until `exp`: the variant / segment lines, and the
 * URI="..." attribute of any tag (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
 * EXT-X-I-FRAME-STREAM-INF, ...). A URI on another host is left as it is.
 * Relative URIs resolve against the playlist's own URL, as hls.js does.
 */
function rewritePlaylist(text: string, playlistUrl: string, userId: string, exp: number): string {
  const proxied = (uri: string) => {
    const abs = resolveUrl(uri, playlistUrl);
    return abs ? signProxyPath(userId, abs, exp) : null;
  };
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) {
      // The attribute named exactly URI (after ":" or ","), not e.g. SERVER-URI.
      return line.replace(/([:,]\s*)URI="([^"]*)"/g, (whole, lead: string, uri: string) => {
        const signed = proxied(uri);
        return signed ? `${lead}URI="${signed}"` : whole;
      });
    }
    return proxied(t) ?? line;
  }).join("\n");
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Logged-in learners only - otherwise this is an open relay for the
  // allowed host, paid for with our bandwidth. A plain 401, not requireUser's
  // redirect: hls.js would follow a redirect to the login page and try to
  // parse its HTML as video, looping on media errors instead of telling the
  // learner they were signed out (HlsPlayer shows that message on a 401).
  const user = await getSessionUser(request);
  if (!user) return new Response("Signed out", { status: 401 });
  const params = new URL(request.url).searchParams;

  const videoUrl = params.get("url") ?? "";
  if (!videoUrl) return new Response("Missing ?url", { status: 400 });
  // A %00 decodes to a NUL, which new URL() accepts but Postgres text cannot
  // hold: the access check below would fail with a 500. No real video URL has
  // one. Other control characters are left alone - the URL parser drops tabs
  // and newlines, so a stored URL with stray whitespace still plays.
  if (videoUrl.includes("\u0000")) return new Response("Invalid URL", { status: 400 });

  let target: URL;
  try { target = new URL(videoUrl); }
  catch { return new Response("Invalid URL", { status: 400 }); }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response("Forbidden", { status: 403 });
  }

  // Signed in is not enough either: registration is open. The page's own
  // request (the playlist named in the lesson) must belong to a course this
  // user holds a licence for. Everything after it - variants, keys, segments -
  // arrives on URLs this proxy signed for the same user, valid until `exp`.
  let exp: number;
  if (params.has("exp") || params.has("sig")) {
    if (!verifyProxySignature(user.id, videoUrl, params.get("exp"), params.get("sig"))) {
      return new Response("Forbidden", { status: 403 });
    }
    exp = Number(params.get("exp"));
  } else {
    if (!videoUrl.includes(".m3u8") || !(await userMayPlay(user, videoUrl))) {
      return new Response("Forbidden", { status: 403 });
    }
    exp = newProxyExpiry();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  let upstream: Response;
  try {
    upstream = await fetch(videoUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Referer": `https://${ALLOWED_HOST}/`,
        ...(request.headers.get("Range") ? { "Range": request.headers.get("Range")! } : {}),
      },
    });
  } catch (err: any) {
    clearTimeout(timer);
    return new Response(`Upstream failed: ${err?.message}`, {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
  clearTimeout(timer);

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Upstream returned ${upstream.status}`, { status: upstream.status });
  }

  const ct = upstream.headers.get("content-type") ?? "";
  const isPlaylist = videoUrl.includes(".m3u8") || ct.toLowerCase().includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    return new Response(rewritePlaylist(text, videoUrl, user.id, exp), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // Holds URLs signed for this user: a shared cache must never keep it.
        "Cache-Control": "private, no-cache",
      },
    });
  }

  // Stream segments through instead of buffering whole files in memory.
  const mime = ct || (videoUrl.endsWith(".ts") ? "video/mp2t" : "application/octet-stream");
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=3600",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
