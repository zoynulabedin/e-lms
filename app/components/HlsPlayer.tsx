/**
 * HlsPlayer — SSR-safe, cross-browser HLS video player
 *
 * Browser support:
 *   Chrome / Edge / Firefox / Opera / Android WebView  → hls.js (via /api/video-proxy)
 *   Safari macOS / iOS / iPadOS                        → native HLS (direct src or proxy)
 *
 * SSR safety:
 *   hls.js is dynamically imported inside useEffect — it never runs on the server.
 *   The <video> element renders on server with no src so there is no hydration mismatch.
 *
 * Proxy:
 *   Pass a /api/video-proxy?url=… src for cross-origin HLS.
 *   The resolveVideoEmbed() helper in student.course.$courseId.tsx does this automatically.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface HlsPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  onEnded?: () => void;
}

type Status = "loading" | "buffering" | "ready" | "error";

export function HlsPlayer({
  src,
  poster,
  className,
  autoPlay = false,
  muted = false,
  onEnded,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const retryRef = useRef(0);
  const MAX_RETRIES = 3;

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [qualities, setQualities] = useState<{ label: string; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = auto

  const destroyHls = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, []);

  // ── Main init effect — runs only in the browser ───────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let cancelled = false;

    // Reset state for each new src
    retryRef.current = 0;
    setErrorMsg(null);
    setStatus("loading");
    setQualities([]);
    setCurrentQuality(-1);

    async function init() {
      // Dynamic import keeps hls.js out of the SSR bundle entirely
      const { default: Hls } = await import("hls.js");
      if (cancelled || !video) return;

      // ── hls.js path (Chrome, Firefox, Edge, Android) ────────────────────
      if (Hls.isSupported()) {
        destroyHls();

        const hls = new Hls({
          // MUST be false — workers use eval() which is blocked by CSP
          enableWorker: false,

          // Buffering
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,

          // Start with auto quality selection
          startLevel: -1,
          abrEwmaDefaultEstimate: 1_500_000,

          // Retry config for unreliable connections
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 4,
          manifestLoadingRetryDelay: 1000,
          levelLoadingRetryDelay: 1000,
          fragLoadingRetryDelay: 1000,
        });

        hlsRef.current = hls;

        // Manifest loaded → video is ready to play
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          if (cancelled) return;
          setStatus("ready");

          const levels = data.levels.map((l, i) => ({
            index: i,
            label: l.height ? `${l.height}p` : `Level ${i + 1}`,
          }));
          setQualities(levels.length > 1 ? levels : []);

          if (autoPlay) video!.play().catch(() => {});
        });

        // Track which quality level is active
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          setCurrentQuality(hls.autoLevelEnabled ? -1 : data.level);
        });

        // Error handling with automatic recovery
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (cancelled || !data.fatal) return;

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (retryRef.current < MAX_RETRIES) {
              retryRef.current += 1;
              console.warn(
                `[HlsPlayer] network error — retry ${retryRef.current}/${MAX_RETRIES}`,
                data.details,
              );
              setTimeout(() => hls.startLoad(), 1500);
            } else {
              setStatus("error");
              setErrorMsg(
                "Could not load video. Check your connection and try again.",
              );
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn("[HlsPlayer] media error — attempting recovery");
            hls.recoverMediaError();
          } else {
            setStatus("error");
            setErrorMsg(`Playback error (${data.details})`);
          }
        });

        hls.loadSource(src);
        hls.attachMedia(video);

      // ── Native HLS path (Safari / iOS / iPadOS) ──────────────────────────
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.load();
        setStatus("ready");
        if (autoPlay) video.play().catch(() => {});

      // ── Unsupported browser ───────────────────────────────────────────────
      } else {
        setStatus("error");
        setErrorMsg(
          "Your browser does not support HLS video. Please try Chrome, Firefox, or Safari.",
        );
      }
    }

    init().catch((err) => {
      if (!cancelled) {
        console.error("[HlsPlayer] init error:", err);
        setStatus("error");
        setErrorMsg(String(err));
      }
    });

    return () => {
      cancelled = true;
      destroyHls();
    };
  }, [src, autoPlay, destroyHls]);

  // ── Retry handler ────────────────────────────────────────────────────────
  function handleRetry() {
    const video = videoRef.current;
    if (!video) return;
    retryRef.current = 0;
    setStatus("loading");
    setErrorMsg(null);

    if (hlsRef.current) {
      hlsRef.current.loadSource(src);
      hlsRef.current.attachMedia(video);
    } else {
      video.load();
      setStatus("ready");
    }
  }

  // ── Quality switcher ─────────────────────────────────────────────────────
  function handleQualityChange(index: number) {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = index;
    setCurrentQuality(index);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className={`relative w-full aspect-video bg-black overflow-hidden ${className ?? ""}`}
    >
      {/* Loading / buffering overlay */}
      {(status === "loading" || status === "buffering") && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/70">
          <svg
            className="w-10 h-10 text-white animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          {status === "buffering" && (
            <span className="text-xs text-white/70">Buffering…</span>
          )}
        </div>
      )}

      {/* Error overlay */}
      {status === "error" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/80 p-6 text-white">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-10 h-10 shrink-0 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            />
          </svg>
          <p className="max-w-xs text-center text-sm text-red-300">
            {errorMsg}
          </p>
          <button
            onClick={handleRetry}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/20"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Quality selector — only shown when multiple levels exist */}
      {qualities.length > 0 && status === "ready" && (
        <div className="absolute top-3 right-3 z-10">
          <select
            value={currentQuality}
            onChange={(e) => handleQualityChange(Number(e.target.value))}
            className="cursor-pointer rounded border border-white/20 bg-black/60 px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option value={-1}>Auto</option>
            {qualities.map((q) => (
              <option key={q.index} value={q.index}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/*
        Notes on <video> attributes:
          playsInline    — prevents iOS from forcing fullscreen on play
          preload        — "metadata" loads duration/dimensions without buffering
          No crossOrigin — src goes through /api/video-proxy (same-origin),
                           so no CORS attribute is needed or wanted
      */}
      <video
        ref={videoRef}
        poster={poster}
        controls
        playsInline
        muted={muted}
        preload="metadata"
        onWaiting={() => setStatus("buffering")}
        onCanPlay={() => {
          if (status !== "error") setStatus("ready");
        }}
        onPlaying={() => setStatus("ready")}
        onEnded={onEnded}
        className="h-full w-full"
      />
    </div>
  );
}
