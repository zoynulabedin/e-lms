import { useEffect, useRef, useState } from "react";

interface HlsPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  /** autoPlay requires muted=true on most browsers/mobile */
  autoPlay?: boolean;
  /** Must be true for autoPlay to work on mobile */
  muted?: boolean;
}

/**
 * HlsPlayer — SSR-safe, cross-browser, mobile-ready HLS component.
 *
 * Browser support matrix:
 *  - Chrome / Edge / Firefox / Opera (desktop + Android) → hls.js
 *  - Safari (macOS + iOS)                                → native HLS
 *  - Samsung Internet / WebView                          → hls.js
 *
 * CORS: If segments fail to load, add `Access-Control-Allow-Origin` on the
 * media server/CDN.  The `crossOrigin="anonymous"` attribute on <video> sends
 * an anonymous CORS request so credentials are never leaked.
 */
export function HlsPlayer({
  src,
  poster,
  className,
  autoPlay = false,
  muted = false,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let cancelled = false;
    setError(null);
    setLoading(true);

    async function init() {
      const { default: Hls } = await import("hls.js");
      if (cancelled) return;

      if (Hls.isSupported()) {
        hlsRef.current?.destroy();

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          // Retry failed segment/manifest requests (helps on flaky mobile networks)
          manifestLoadingMaxRetry: 3,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 3,
        });

        hlsRef.current = hls;

        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // Try to recover from a network stall
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError(`Playback error: ${data.details}`);
          }
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          setLoading(false);
          if (autoPlay) video!.play().catch(() => {});
        });

        hls.loadSource(src);
        hls.attachMedia(video!);
      } else if (video!.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari / iOS native HLS
        video!.src = src;
        video!.load();
        setLoading(false);
        if (autoPlay) video!.play().catch(() => {});
      } else {
        setError("Your browser does not support HLS video playback.");
        setLoading(false);
      }
    }

    init().catch((err) => {
      if (!cancelled) {
        setError(String(err));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src, autoPlay]);

  return (
    <div
      className={`relative w-full aspect-video bg-black rounded-xl overflow-hidden ${className ?? ""}`}
    >
      {/* Loading spinner */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
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
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 p-6 z-10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-10 h-10 text-red-400 shrink-0"
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
          <p className="text-sm text-center text-red-300 max-w-xs">{error}</p>
        </div>
      )}

      {/* Video element
          crossOrigin="anonymous" — required for CORS-restricted streams.
          playsInline          — prevents iOS from forcing fullscreen.
          x-webkit-airplay     — enables AirPlay on Safari/iOS.
      */}
      <video
        ref={videoRef}
        poster={poster}
        controls
        playsInline
        muted={muted}
        preload="metadata"
        crossOrigin="anonymous"
        // @ts-expect-error – non-standard but needed for AirPlay on iOS
        x-webkit-airplay="allow"
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => setLoading(false)}
        className="w-full h-full"
      />
    </div>
  );
}
