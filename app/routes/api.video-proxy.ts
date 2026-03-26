/**
 * /api/video-proxy
 *
 * Server-side HLS proxy for courses.instructionalgraphics.org
 *
 * Why this exists:
 *   The video server does not send CORS headers, so browsers block
 *   cross-origin XHR from hls.js.  This proxy makes every request
 *   appear same-origin to the browser.
 *
 * What it handles:
 *   • .m3u8 master/media playlists  — rewrites all segment / sub-manifest
 *     URLs so they flow through this same proxy endpoint
 *   • .ts / .mp4 / .m4s segments    — streamed directly (no buffering)
 *   • .key encryption key files     — proxied for AES-128 encrypted streams
 *   • Range requests                — forwarded so seeking works correctly
 *   • User-Agent / Referer spoofing — some CDNs reject non-browser requests
 */

import type { LoaderFunctionArgs } from "react-router";

// ── Config ──────────────────────────────────────────────────────────────────
const ALLOWED_HOST = "courses.instructionalgraphics.org";

// Mimic a real browser so the upstream server doesn't reject the request
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a (possibly relative) path to an absolute URL. */
function resolveSegmentUrl(path: string, baseUrl: string): string | null {
  try {
    let absolute: string;
    if (path.startsWith("https://") || path.startsWith("http://")) {
      absolute = path;
    } else if (path.startsWith("//")) {
      absolute = "https:" + path;
    } else if (path.startsWith("/")) {
      // Root-relative — attach host
      const base = new URL(baseUrl);
      absolute = `${base.protocol}//${base.host}${path}`;
    } else {
      // Relative to the manifest directory
      absolute = baseUrl + path;
    }

    const parsed = new URL(absolute);
    // Only proxy segments from the allowed host
    return parsed.hostname === ALLOWED_HOST ? absolute : null;
  } catch {
    return null;
  }
}

/** Return true if this URL / content-type is an HLS playlist. */
function isPlaylist(url: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    url.includes(".m3u8") ||
    ct.includes("mpegurl") ||
    ct.includes("x-mpegurl") ||
    ct.includes("vnd.apple.mpegurl")
  );
}

/**
 * Walk every line of an m3u8 and redirect segment / key / sub-manifest
 * URLs through our proxy.
 */
function rewritePlaylist(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // ── EXT-X-KEY URI — encryption key for AES-128 segments ──────────────
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_match, uri) => {
          const abs = resolveSegmentUrl(uri, baseUrl);
          if (!abs) return _match;
          return `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"`;
        });
      }

      // Skip all other comment / tag lines
      if (trimmed.startsWith("#")) return line;

      // ── Segment or sub-manifest line ──────────────────────────────────────
      const abs = resolveSegmentUrl(trimmed, baseUrl);
      if (abs) {
        return `/api/video-proxy?url=${encodeURIComponent(abs)}`;
      }

      return line;
    })
    .join("\n");
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  // ── Parse and validate the target URL ──────────────────────────────────────
  const incoming = new URL(request.url);
  const videoUrl = incoming.searchParams.get("url") ?? "";

  if (!videoUrl) {
    return new Response("Missing ?url parameter", { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(videoUrl);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response("Forbidden: host not in allowlist", { status: 403 });
  }

  // ── Build upstream request headers ─────────────────────────────────────────
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    // Disable content encoding — we stream raw bytes for segments
    "Accept-Encoding": "identity",
    // Tell the upstream server where this "browser" came from
    Referer: `https://${ALLOWED_HOST}/`,
    Origin: `https://${ALLOWED_HOST}`,
  };

  // Forward Range header so the client can seek inside a segment
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  // ── Fetch from upstream ────────────────────────────────────────────────────
  let upstream: Response;
  try {
    upstream = await fetch(videoUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("[video-proxy] upstream fetch failed:", videoUrl, err);
    return new Response("Upstream unreachable", { status: 502 });
  }

  // Accept 200 OK and 206 Partial Content; anything else is an error
  if (upstream.status !== 200 && upstream.status !== 206) {
    console.error(
      "[video-proxy] upstream returned",
      upstream.status,
      videoUrl,
    );
    return new Response(`Upstream returned ${upstream.status}`, {
      status: upstream.status,
    });
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  // ── HLS playlist (.m3u8) ───────────────────────────────────────────────────
  if (isPlaylist(videoUrl, contentType)) {
    let text: string;
    try {
      text = await upstream.text();
    } catch (err) {
      console.error("[video-proxy] failed to read manifest body:", err);
      return new Response("Failed to read upstream manifest", { status: 502 });
    }

    // The base URL is the directory that contains this manifest
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);
    const rewritten = rewritePlaylist(text, baseUrl);

    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // Playlists must not be cached — hls.js reloads them for live streams
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // ── Media segments and other binary files (.ts, .mp4, .m4s, .key…) ─────────
  const responseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges",
  };

  // Pass through caching and range headers from upstream
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "last-modified",
    "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders[h] = v;
  }

  // Ensure correct MIME type when the server omits or uses a generic one
  if (
    !responseHeaders["content-type"] ||
    responseHeaders["content-type"] === "application/octet-stream"
  ) {
    if (videoUrl.endsWith(".ts"))
      responseHeaders["content-type"] = "video/mp2t";
    else if (videoUrl.endsWith(".mp4") || videoUrl.endsWith(".m4s"))
      responseHeaders["content-type"] = "video/mp4";
    else if (videoUrl.endsWith(".aac"))
      responseHeaders["content-type"] = "audio/aac";
    else if (videoUrl.endsWith(".vtt") || videoUrl.endsWith(".webvtt"))
      responseHeaders["content-type"] = "text/vtt";
  }

  // Stream the body directly — never buffer a whole .ts segment in memory
  return new Response(upstream.body, {
    status: upstream.status, // preserve 206 for range responses
    headers: responseHeaders,
  });
}
