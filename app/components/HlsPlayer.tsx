import { useCallback, useEffect, useRef, useState } from "react";

interface HlsPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  /** autoPlay requires muted=true on most mobile browsers */
  autoPlay?: boolean;
  muted?: boolean;
  onEnded?: () => void;
}

type Status = "loading" | "buffering" | "ready" | "error";

/**
 * HlsPlayer — SSR-safe, cross-browser, mobile-ready HLS video player.
 *
 * Browser support:
 *  Chrome / Edge / Firefox / Opera (desktop + Android)  → hls.js
 *  Safari macOS / iOS / iPadOS                          → native HLS
 *  Samsung Internet / Android WebView                   → hls.js
 *
 * CORS: the media server must respond with
 *   Access-Control-Allow-Origin: https://lms.instructionalgraphics.org
 */
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
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;

  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [qualities, setQualities] = useState<{ label: string; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number>(-1); // -1 = auto

  // ── Destroy helper ──────────────────────────────────────────────────────────
  const destroyHls = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, []);

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let cancelled = false;
    retryCountRef.current = 0;
    setErrorMsg(null);
    setStatus("loading");
    setQualities([]);
    setCurrentQuality(-1);

    async function init() {
      const { default: Hls } = await import("hls.js");
      if (cancelled || !video) return;

      // ── hls.js path (Chrome / Firefox / Edge / Android) ──────────────────
      if (Hls.isSupported()) {
        destroyHls();

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          startLevel: -1,          // auto quality on start
          abrEwmaDefaultEstimate: 1_000_000,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 4,
          manifestLoadingRetryDelay: 1000,
          levelLoadingRetryDelay: 1000,
          fragLoadingRetryDelay: 1000,
          // Pass credentials-free CORS requests
          xhrSetup(xhr) {
            xhr.withCredentials = false;
          },
        });

        hlsRef.current = hls;

        // Quality levels available after manifest parsed
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

        // Track current auto-selected level
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          if (hls.autoLevelEnabled) setCurrentQuality(-1);
          else setCurrentQuality(data.level);
        });

        // Error recovery
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (cancelled || !data.fatal) return;

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current += 1;
              setTimeout(() => hls.startLoad(), 1500);
            } else {
              setStatus("error");
              setErrorMsg("Network error — check your connection and try again.");
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setStatus("error");
            setErrorMsg(`Playback error: ${data.details}`);
          }
        });

        hls.loadSource(src);
        hls.attachMedia(video as HTMLMediaElement);

      // ── Native HLS path (Safari / iOS / iPadOS) ───────────────────────────
      } else if ((video as HTMLVideoElement).canPlayType("application/vnd.apple.mpegurl")) {
        (video as HTMLVideoElement).src = src;
        (video as HTMLVideoElement).load();
        setStatus("ready");
        if (autoPlay) (video as HTMLVideoElement).play().catch(() => {});

      // ── Unsupported ───────────────────────────────────────────────────────
      } else {
        setStatus("error");
        setErrorMsg("Your browser does not support HLS video. Please try Chrome, Firefox, or Safari.");
      }
    }

    init().catch((err) => {
      if (!cancelled) {
        setStatus("error");
        setErrorMsg(String(err));
      }
    });

    return () => {
      cancelled = true;
      destroyHls();
    };
  }, [src, autoPlay, destroyHls]);

  // ── Retry handler ───────────────────────────────────────────────────────────
  function handleRetry() {
    const video = videoRef.current;
    if (!video) return;
    setStatus("loading");
    setErrorMsg(null);
    retryCountRef.current = 0;
    // Re-trigger the effect by resetting src on the hls instance
    if (hlsRef.current) {
      hlsRef.current.loadSource(src);
      hlsRef.current.attachMedia(video);
    } else {
      // Safari path — just reload
      video.load();
      setStatus("ready");
    }
  }

  // ── Quality switcher ────────────────────────────────────────────────────────
  function handleQualityChange(index: number) {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = index;
    setCurrentQuality(index);
  }

  return (
    <div className={`relative w-full aspect-video bg-black overflow-hidden ${className ?? ""}`}>

      {/* Loading / buffering overlay */}
      {(status === "loading" || status === "buffering") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 gap-3">
          <svg
            className="w-10 h-10 text-white animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          {status === "buffering" && (
            <span className="text-white/70 text-xs">Buffering…</span>
          )}
        </div>
      )}

      {/* Error overlay */}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-white gap-4 p-6 z-10">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <p className="text-sm text-center text-red-300 max-w-xs">{errorMsg}</p>
          <button
            onClick={handleRetry}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors"
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
            className="bg-black/60 text-white text-xs rounded px-2 py-1 border border-white/20 focus:outline-none cursor-pointer"
          >
            <option value={-1}>Auto</option>
            {qualities.map((q) => (
              <option key={q.index} value={q.index}>{q.label}</option>
            ))}
          </select>
        </div>
      )}

      {/*
        Video element attributes:
          playsInline       — prevents iOS from forcing fullscreen
          crossOrigin       — required for CORS HLS segments
          x-webkit-airplay  — AirPlay on Safari/iOS
      */}
      <video
        ref={videoRef}
        poster={poster}
        controls
        playsInline
        muted={muted}
        preload="metadata"
        crossOrigin="anonymous"
        x-webkit-airplay="allow"
        onWaiting={() => setStatus("buffering")}
        onCanPlay={() => { if (status !== "error") setStatus("ready"); }}
        onPlaying={() => setStatus("ready")}
        onEnded={onEnded}
        className="w-full h-full"
      />
    </div>
  );
}
