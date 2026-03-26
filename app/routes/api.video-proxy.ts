/**
 * /api/video-proxy
 * Optimized for React Router v7 & Node.js environments
 */
import type { LoaderFunctionArgs } from "react-router";
import https from "https";
import http from "http";

const ALLOWED_HOST = "courses.instructionalgraphics.org";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface UpstreamResponse {
  status: number;
  headers: any;
  buffer: Buffer;
}

function nodeFetch(url: string, reqHeaders: any): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const options = {
      method: "GET",
      headers: reqHeaders,
      timeout: 15000,
    };

    const req = lib.get(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 200,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
      res.on("error", reject); // needed: response stream can error mid-transfer
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request Timeout"));
    });
  });
}

function resolveSegmentUrl(path: string, baseUrl: string): string | null {
  try {
    const absolute = new URL(path, baseUrl).href;
    return new URL(absolute).hostname === ALLOWED_HOST ? absolute : null;
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) return new Response("Missing URL", { status: 400 });

    const targetUrl = new URL(url);
    if (targetUrl.hostname !== ALLOWED_HOST) {
      return new Response("Forbidden Host", { status: 403 });
    }

    const headers: any = {
      "User-Agent": BROWSER_UA,
      "Accept": "*/*",
      "Accept-Encoding": "identity", // prevent gzip — we pass raw bytes to browser
      "Referer": `https://${ALLOWED_HOST}/`,
    };

    const range = request.headers.get("Range");
    if (range) headers["Range"] = range;

    const upstream = await nodeFetch(url, headers);

    if (upstream.status >= 400) {
      return new Response(`Upstream Error: ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const contentType = (upstream.headers["content-type"] || "").toString();

    // ── HLS Playlist (.m3u8) ──
    if (url.includes(".m3u8") || contentType.includes("mpegurl")) {
      const text = upstream.buffer.toString("utf-8");
      const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);

      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (
            !trimmed ||
            trimmed.startsWith("#EXT-X-VERSION") ||
            trimmed.startsWith("#EXT-X-TARGET")
          )
            return line;

          // Handle Keys
          if (trimmed.startsWith("#EXT-X-KEY")) {
            return line.replace(/URI="([^"]+)"/, (_, uri) => {
              const abs = resolveSegmentUrl(uri, baseUrl);
              return abs
                ? `URI="/api/video-proxy?url=${encodeURIComponent(abs)}"`
                : _;
            });
          }

          if (trimmed.startsWith("#")) return line;

          const abs = resolveSegmentUrl(trimmed, baseUrl);
          return abs ? `/api/video-proxy?url=${encodeURIComponent(abs)}` : line;
        })
        .join("\n");

      return new Response(rewritten, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    // ── Video Segments (.ts, .mp4) ──
    const resHeaders: any = {
      "Content-Type": upstream.headers["content-type"] || "video/mp2t",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    };

    if (upstream.headers["content-range"])
      resHeaders["Content-Range"] = upstream.headers["content-range"];
    if (upstream.headers["content-length"])
      resHeaders["Content-Length"] = upstream.headers["content-length"];

    // Uint8Array তে কনভার্ট করা নোড বাফারকে ওয়েভ স্ট্যান্ডার্ডে পাঠানোর জন্য জরুরি
    return new Response(new Uint8Array(upstream.buffer), {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err: any) {
    return new Response(`Proxy Error: ${err.message}`, { status: 500 });
  }
}
