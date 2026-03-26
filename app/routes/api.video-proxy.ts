import type { LoaderFunctionArgs } from "react-router";
import { createRequire } from "node:module";

// createRequire loads Node built-ins at runtime, bypassing Vite bundling entirely
const require = createRequire(import.meta.url);
const https = require("https") as typeof import("https");
const http  = require("http")  as typeof import("http");

const ALLOWED_HOST = "courses.instructionalgraphics.org";
const BROWSER_UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function resolveSegmentUrl(path: string, baseUrl: string): string | null {
  try {
    const abs = new URL(path, baseUrl).href;
    return new URL(abs).hostname === ALLOWED_HOST ? abs : null;
  } catch { return null; }
}

function proxyFetch(videoUrl: string, extraHeaders: Record<string, string>): Promise<{
  status: number;
  headers: Record<string, any>;
  buffer: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(videoUrl);
    const lib      = parsed.protocol === "https:" ? https : http;
    const options  = {
      hostname : parsed.hostname,
      port     : parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : "GET",
      headers  : {
        "User-Agent"      : BROWSER_UA,
        "Accept"          : "*/*",
        "Accept-Encoding" : "identity",
        "Referer"         : `https://${ALLOWED_HOST}/`,
        ...extraHeaders,
      },
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data",  (c: Buffer) => chunks.push(c));
      res.on("end",   ()          => resolve({ status: res.statusCode ?? 200, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on("error", reject);
    });

    req.setTimeout(20_000, () => req.destroy(new Error("Upstream timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;

  if (params.get("debug") === "1") {
    return new Response(JSON.stringify({ ok: true, node: process.version, httpsType: typeof https.request }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const videoUrl = params.get("url") ?? "";
  if (!videoUrl) return new Response("Missing ?url", { status: 400 });

  let target: URL;
  try { target = new URL(videoUrl); }
  catch { return new Response("Invalid URL", { status: 400 }); }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response(`Forbidden: ${target.hostname}`, { status: 403 });
  }

  const extra: Record<string, string> = {};
  const range = request.headers.get("Range");
  if (range) extra["Range"] = range;

  let up: { status: number; headers: Record<string, any>; buffer: Buffer };
  try {
    up = await proxyFetch(videoUrl, extra);
  } catch (err: any) {
    const msg = `Upstream failed: ${err?.message ?? err}`;
    console.error("[video-proxy]", msg);
    return new Response(msg, { status: 502, headers: { "Content-Type": "text/plain" } });
  }

  if (up.status >= 400) {
    return new Response(`Upstream ${up.status}`, { status: up.status, headers: { "Content-Type": "text/plain" } });
  }

  const ct        = String(up.headers["content-type"] ?? "").toLowerCase();
  const isPlaylist = videoUrl.includes(".m3u8") || ct.includes("mpegurl");

  if (isPlaylist) {
    const text    = up.buffer.toString("utf-8");
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);

    const rewritten = text.split("\n").map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#EXT-X-KEY") && t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          const abs = resolveSegmentUrl(uri, baseUrl);
          return abs ? `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"` : _;
        });
      }
      if (t.startsWith("#")) return line;
      const abs = resolveSegmentUrl(t, baseUrl);
      return abs ? `/api/video-proxy?url=${encodeURIComponent(abs)}` : line;
    }).join("\n");

    return new Response(rewritten, {
      headers: {
        "Content-Type"              : "application/vnd.apple.mpegurl",
        "Cache-Control"             : "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Binary segment
  const mime = ct && ct !== "application/octet-stream" ? ct
    : videoUrl.endsWith(".ts")  ? "video/mp2t"
    : videoUrl.endsWith(".mp4") ? "video/mp4"
    : "application/octet-stream";

  const resHeaders: Record<string, string> = {
    "Content-Type"               : mime,
    "Content-Length"             : String(up.buffer.byteLength),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
  };
  const cr = up.headers["content-range"];
  if (cr) resHeaders["Content-Range"] = String(cr);

  return new Response(new Uint8Array(up.buffer), { status: up.status, headers: resHeaders });
}
