import type { LoaderFunctionArgs } from "react-router";

const ALLOWED_HOST = "courses.instructionalgraphics.org";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSegmentUrl(path: string, baseUrl: string): string | null {
  try {
    let absolute: string;
    if (path.startsWith("https://") || path.startsWith("http://")) {
      absolute = path;
    } else if (path.startsWith("//")) {
      absolute = "https:" + path;
    } else if (path.startsWith("/")) {
      const base = new URL(baseUrl);
      absolute = `${base.protocol}//${base.host}${path}`;
    } else {
      absolute = baseUrl + path;
    }
    const parsed = new URL(absolute);
    return parsed.hostname === ALLOWED_HOST ? absolute : null;
  } catch {
    return null;
  }
}

function isPlaylist(url: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    url.includes(".m3u8") ||
    ct.includes("mpegurl") ||
    ct.includes("x-mpegurl") ||
    ct.includes("vnd.apple.mpegurl")
  );
}

function rewritePlaylist(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_match, uri) => {
          const abs = resolveSegmentUrl(uri, baseUrl);
          if (!abs) return _match;
          return `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"`;
        });
      }

      if (trimmed.startsWith("#")) return line;

      const abs = resolveSegmentUrl(trimmed, baseUrl);
      if (abs) return `/api/video-proxy?url=${encodeURIComponent(abs)}`;
      return line;
    })
    .join("\n");
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  try {
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

    const upstreamHeaders: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      "Accept-Encoding": "identity",
      Referer: `https://${ALLOWED_HOST}/`,
      Origin: `https://${ALLOWED_HOST}`,
    };

    const rangeHeader = request.headers.get("Range");
    if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

    // ── Use AbortController (works on Node 14+, unlike AbortSignal.timeout) ──
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    let upstream: Response;
    try {
      upstream = await fetch(videoUrl, {
        headers: upstreamHeaders,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error("[video-proxy] upstream fetch failed:", videoUrl, String(err));
      return new Response(`Upstream unreachable: ${String(err)}`, { status: 502 });
    }
    clearTimeout(timeoutId);

    if (upstream.status !== 200 && upstream.status !== 206) {
      console.error("[video-proxy] upstream returned", upstream.status, videoUrl);
      return new Response(`Upstream returned ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    // ── HLS playlist (.m3u8) ──────────────────────────────────────────────────
    if (isPlaylist(videoUrl, contentType)) {
      const text = await upstream.text();
      const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);
      const rewritten = rewritePlaylist(text, baseUrl);

      return new Response(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Media segments (.ts, .mp4, .m4s, .key…) ──────────────────────────────
    // Buffer the full response — streaming via upstream.body is unreliable
    // with Phusion Passenger and some Nginx proxy configurations.
    const buffer = await upstream.arrayBuffer();

    const responseHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Content-Length": String(buffer.byteLength),
    };

    for (const h of ["content-type", "content-range", "accept-ranges", "cache-control"]) {
      const v = upstream.headers.get(h);
      if (v) responseHeaders[h] = v;
    }

    // Ensure correct MIME type
    if (!responseHeaders["content-type"] || responseHeaders["content-type"] === "application/octet-stream") {
      if (videoUrl.endsWith(".ts"))       responseHeaders["content-type"] = "video/mp2t";
      else if (videoUrl.endsWith(".mp4") || videoUrl.endsWith(".m4s")) responseHeaders["content-type"] = "video/mp4";
      else if (videoUrl.endsWith(".aac")) responseHeaders["content-type"] = "audio/aac";
      else if (videoUrl.endsWith(".key")) responseHeaders["content-type"] = "application/octet-stream";
    }

    return new Response(buffer, {
      status: upstream.status,
      headers: responseHeaders,
    });

  } catch (err: any) {
    // Top-level catch — prevents unhandled rejections from becoming 500s
    console.error("[video-proxy] unhandled error:", String(err));
    return new Response(`Proxy error: ${String(err)}`, { status: 500 });
  }
}
