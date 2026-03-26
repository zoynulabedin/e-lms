/**
 * /api/video-proxy  — HLS stream proxy
 *
 * Uses Node's built-in `https` module (NOT global fetch) so it works on
 * every Node.js version including 14, 16, 17 running on Plesk.
 *
 * What it does:
 *  1. Receives ?url= pointing at courses.instructionalgraphics.org
 *  2. Fetches the resource server-to-server (no CORS restriction)
 *  3. For .m3u8 manifests: rewrites all segment URLs → /api/video-proxy?url=…
 *  4. For .ts/.mp4 segments: buffers & returns with correct MIME type
 */

import type { LoaderFunctionArgs } from "react-router";
import https from "https";
import http from "http";

// ── Config ────────────────────────────────────────────────────────────────────
const ALLOWED_HOST = "courses.instructionalgraphics.org";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// ── Node-native HTTP fetch ────────────────────────────────────────────────────

interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  buffer: Buffer;
}

function nodeFetch(
  url: string,
  reqHeaders: Record<string, string>,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: reqHeaders,
      timeout: 20_000,
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];

      res.on("data", (chunk: Buffer) => chunks.push(chunk));

      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 200,
          headers: res.headers as Record<string, string | string[] | undefined>,
          buffer: Buffer.concat(chunks),
        });
      });

      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error("Upstream request timed out after 20s"));
    });

    req.on("error", reject);
    req.end();
  });
}

// ── URL helpers ───────────────────────────────────────────────────────────────

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
    return new URL(absolute).hostname === ALLOWED_HOST ? absolute : null;
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

      // Rewrite encryption key URIs
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          const abs = resolveSegmentUrl(uri, baseUrl);
          return abs
            ? `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"`
            : _m;
        });
      }

      if (trimmed.startsWith("#")) return line;

      // Rewrite segment / sub-manifest lines
      const abs = resolveSegmentUrl(trimmed, baseUrl);
      return abs
        ? `/api/video-proxy?url=${encodeURIComponent(abs)}`
        : line;
    })
    .join("\n");
}

function getMimeType(url: string, upstreamContentType: string): string {
  if (upstreamContentType && upstreamContentType !== "application/octet-stream") {
    return upstreamContentType;
  }
  if (url.endsWith(".ts"))  return "video/mp2t";
  if (url.endsWith(".mp4") || url.endsWith(".m4s")) return "video/mp4";
  if (url.endsWith(".aac")) return "audio/aac";
  if (url.endsWith(".vtt") || url.endsWith(".webvtt")) return "text/vtt";
  if (url.endsWith(".key")) return "application/octet-stream";
  return upstreamContentType || "application/octet-stream";
}

// ── Route loader ──────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const incoming = new URL(request.url);
    const videoUrl = incoming.searchParams.get("url") ?? "";

    // ── Validate ────────────────────────────────────────────────────────────
    if (!videoUrl) {
      return new Response("Missing ?url parameter", { status: 400 });
    }

    let target: URL;
    try {
      target = new URL(videoUrl);
    } catch {
      return new Response("Invalid URL in ?url parameter", { status: 400 });
    }

    if (target.hostname !== ALLOWED_HOST) {
      return new Response(
        `Forbidden: ${target.hostname} is not in the allowlist`,
        { status: 403 },
      );
    }

    // ── Build request headers ───────────────────────────────────────────────
    const reqHeaders: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      "Accept-Encoding": "identity", // no gzip — we pass raw bytes
      Referer: `https://${ALLOWED_HOST}/`,
      Origin: `https://${ALLOWED_HOST}`,
    };

    const range = request.headers.get("Range");
    if (range) reqHeaders["Range"] = range;

    // ── Fetch upstream ──────────────────────────────────────────────────────
    let upstream: UpstreamResponse;
    try {
      upstream = await nodeFetch(videoUrl, reqHeaders);
    } catch (err: any) {
      console.error("[video-proxy] nodeFetch error:", String(err));
      return new Response(`Upstream fetch failed: ${String(err)}`, {
        status: 502,
      });
    }

    if (upstream.status !== 200 && upstream.status !== 206) {
      console.error("[video-proxy] upstream status:", upstream.status, videoUrl);
      return new Response(
        `Upstream returned HTTP ${upstream.status} for ${videoUrl}`,
        { status: upstream.status },
      );
    }

    const upstreamCT = (
      (upstream.headers["content-type"] as string) ?? ""
    ).split(";")[0].trim();

    // ── HLS playlist ────────────────────────────────────────────────────────
    if (isPlaylist(videoUrl, upstreamCT)) {
      const text = upstream.buffer.toString("utf-8");
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

    // ── Media segments ──────────────────────────────────────────────────────
    const mimeType = getMimeType(videoUrl, upstreamCT);

    const resHeaders: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(upstream.buffer.byteLength),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };

    for (const h of ["content-range", "accept-ranges", "cache-control"]) {
      const v = upstream.headers[h];
      if (v) resHeaders[h] = Array.isArray(v) ? v[0] : v;
    }

    return new Response(new Uint8Array(upstream.buffer), {
      status: upstream.status,
      headers: resHeaders,
    });

  } catch (err: any) {
    console.error("[video-proxy] unhandled exception:", String(err));
    return new Response(`Internal proxy error: ${String(err)}`, { status: 500 });
  }
}
