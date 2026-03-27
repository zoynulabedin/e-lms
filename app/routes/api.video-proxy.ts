import type { LoaderFunctionArgs } from "react-router";

// No Node.js imports — uses only global fetch (Node 18+) and global process

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

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;

  // Connectivity test — open ?debug=1 in browser to confirm route is live
  if (params.get("debug") === "1") {
    return new Response(
      JSON.stringify({ ok: true, node: process.version }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const videoUrl = params.get("url") ?? "";
  if (!videoUrl) return new Response("Missing ?url", { status: 400 });

  let target: URL;
  try { target = new URL(videoUrl); }
  catch { return new Response("Invalid URL", { status: 400 }); }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response("Forbidden", { status: 403 });
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

  const ct = upstream.headers.get("content-type") ?? "";
  const isPlaylist = videoUrl.includes(".m3u8") || ct.toLowerCase().includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    const baseUrl = videoUrl.slice(0, videoUrl.lastIndexOf("/") + 1);

    const rewritten = text.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#EXT-X-KEY") && t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          const abs = resolveUrl(uri, baseUrl);
          return abs ? `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"` : _;
        });
      }
      if (t.startsWith("#")) return line;
      const abs = resolveUrl(t, baseUrl);
      return abs ? `/api/video-proxy?url=${encodeURIComponent(abs)}` : line;
    }).join("\n");

    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const buffer = await upstream.arrayBuffer();
  const mime = ct || (videoUrl.endsWith(".ts") ? "video/mp2t" : "application/octet-stream");

  return new Response(buffer, {
    status: upstream.status,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buffer.byteLength),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range",
      ...(upstream.headers.get("Content-Range") ? { "Content-Range": upstream.headers.get("Content-Range")! } : {}),
    },
  });
}
