import type { LoaderFunctionArgs } from "react-router";

const ALLOWED_HOST = "courses.instructionalgraphics.org";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function resolveSegmentUrl(path: string, baseUrl: string): string | null {
  try {
    const absolute = new URL(path, baseUrl).href;
    return new URL(absolute).hostname === ALLOWED_HOST ? absolute : null;
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;

  // ?debug=1 — confirms the route is live and shows Node version
  if (params.get("debug") === "1") {
    return new Response(
      JSON.stringify({ ok: true, node: process.version, host: ALLOWED_HOST }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const videoUrl = params.get("url") ?? "";
  if (!videoUrl) return new Response("Missing ?url", { status: 400 });

  let target: URL;
  try {
    target = new URL(videoUrl);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response(`Forbidden: ${target.hostname}`, { status: 403 });
  }

  // Build headers for upstream request
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Referer: `https://${ALLOWED_HOST}/`,
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  // Fetch from upstream using global fetch (Node 18+, no imports needed)
  let upstream: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    upstream = await fetch(videoUrl, {
      headers: upstreamHeaders,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const msg = `Upstream fetch failed: ${err?.message ?? String(err)}`;
    console.error("[video-proxy]", msg);
    return new Response(msg, { status: 502, headers: { "Content-Type": "text/plain" } });
  }
  clearTimeout(timer);

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Upstream returned ${upstream.status}`, {
      status: upstream.status,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const isPlaylist = videoUrl.includes(".m3u8") || contentType.includes("mpegurl");

  // ── HLS playlist: rewrite segment URLs through this proxy ─────────────────
  if (isPlaylist) {
    const text = await upstream.text();
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          // Rewrite encryption key URIs inside #EXT-X-KEY lines
          if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/, (_, uri) => {
              const abs = resolveSegmentUrl(uri, baseUrl);
              return abs ? `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"` : _;
            });
          }
          return line;
        }
        const abs = resolveSegmentUrl(trimmed, baseUrl);
        return abs ? `/api/video-proxy?url=${encodeURIComponent(abs)}` : line;
      })
      .join("\n");

    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // ── Media segments: buffer and return ─────────────────────────────────────
  const buffer = await upstream.arrayBuffer();

  const mime =
    contentType && contentType !== "application/octet-stream"
      ? contentType
      : videoUrl.endsWith(".ts") ? "video/mp2t"
      : videoUrl.endsWith(".mp4") || videoUrl.endsWith(".m4s") ? "video/mp4"
      : videoUrl.endsWith(".aac") ? "audio/aac"
      : "application/octet-stream";

  const resHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(buffer.byteLength),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };

  const cr = upstream.headers.get("content-range");
  if (cr) resHeaders["Content-Range"] = cr;

  return new Response(buffer, { status: upstream.status, headers: resHeaders });
}
