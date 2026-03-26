import type { LoaderFunctionArgs } from "react-router";

const ALLOWED_HOST = "courses.instructionalgraphics.org";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const videoUrl = url.searchParams.get("url") ?? "";

  // ── Security: only proxy from the allowed host ──────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(videoUrl);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  if (parsed.hostname !== ALLOWED_HOST) {
    return new Response("Forbidden", { status: 403 });
  }

  // ── Forward Range header (needed for video seeking) ─────────────────────────
  const upstreamHeaders: Record<string, string> = {};
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(videoUrl, {
      headers: upstreamHeaders,
      // server-to-server, no credentials needed
    });
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isManifest =
    videoUrl.endsWith(".m3u8") ||
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegURL");

  // ── m3u8 manifest: rewrite segment/sub-manifest URLs through this proxy ─────
  if (isManifest) {
    const text = await upstream.text();
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        // Keep comment lines and empty lines as-is
        if (!trimmed || trimmed.startsWith("#")) return line;

        // Resolve to absolute URL
        const absolute =
          trimmed.startsWith("http://") || trimmed.startsWith("https://")
            ? trimmed
            : baseUrl + trimmed;

        // Only proxy if same allowed host
        try {
          const u = new URL(absolute);
          if (u.hostname === ALLOWED_HOST) {
            return `/api/video-proxy?url=${encodeURIComponent(absolute)}`;
          }
        } catch {
          // not a URL — leave as-is
        }
        return line;
      })
      .join("\n");

    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // ── Video segments (.ts, .mp4, etc.) — stream through ───────────────────────
  const responseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };

  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
  ]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders[h] = v;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
