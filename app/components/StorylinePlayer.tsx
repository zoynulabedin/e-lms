import { forwardRef, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

interface StorylinePlayerProps {
  /** Storyline iframe src (story.html URL or full embed URL) */
  src: string;
  /** Lesson ID for tracking */
  lessonId: string;
  /** Where to navigate when lesson completes — null disables auto-advance */
  nextLessonUrl: string | null;
  /** Called when the iframe posts `lessonComplete` (use to persist progress) */
  onComplete?: (lessonId: string) => void;
  /**
   * Allowed origins for postMessage. The component always accepts the
   * `src` URL's origin. Pass extra hosts here if your Storyline content
   * is served from multiple origins.
   */
  allowedOrigins?: string[];
  /** iframe attributes — forwarded as-is */
  title?: string;
  className?: string;
  allow?: string;
  sandbox?: string;
}

const DEFAULT_HOST = "https://courses.instructionalgraphics.org";

export const StorylinePlayer = forwardRef<HTMLIFrameElement, StorylinePlayerProps>(
  function StorylinePlayer(
    {
      src,
      lessonId,
      nextLessonUrl,
      onComplete,
      allowedOrigins,
      title = "Storyline Course",
      className,
      allow = "autoplay; fullscreen",
      sandbox,
    },
    ref,
  ) {
    const navigate = useNavigate();
    const [countdown, setCountdown] = useState<number | null>(null);

    const allowedOriginSet = useMemo(() => {
      const set = new Set<string>();
      try {
        set.add(new URL(src).origin);
      } catch {
        // src is relative or invalid — fall back to defaults only
      }
      set.add(DEFAULT_HOST);
      for (const o of allowedOrigins ?? []) set.add(o);
      return set;
    }, [src, allowedOrigins]);

    useEffect(() => {
      function handleMessage(event: MessageEvent) {
        if (!allowedOriginSet.has(event.origin)) return;
        const payload = event.data;
        if (!payload || typeof payload !== "object") return;
        if (payload.action !== "lessonComplete") return;

        onComplete?.(lessonId);
        if (nextLessonUrl) setCountdown(5);
      }
      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, [lessonId, nextLessonUrl, onComplete, allowedOriginSet]);

    // Countdown ticker — drives auto-advance at zero
    useEffect(() => {
      if (countdown === null) return;
      if (countdown <= 0) {
        if (nextLessonUrl) navigate(nextLessonUrl);
        return;
      }
      const t = setTimeout(
        () => setCountdown((c) => (c === null ? null : c - 1)),
        1000,
      );
      return () => clearTimeout(t);
    }, [countdown, nextLessonUrl, navigate]);

    return (
      <>
        <iframe
          ref={ref}
          src={src}
          title={title}
          className={className}
          allow={allow}
          sandbox={sandbox}
          allowFullScreen
        />

        {countdown !== null && countdown > 0 && (
          <div className="fixed bottom-8 right-8 z-[9999] animate-slide-in">
            <div className="bg-black/85 text-white px-7 py-5 rounded-xl shadow-2xl text-center min-w-[280px]">
              <p className="text-sm text-gray-300 mb-1">
                Next lesson starting in...
              </p>
              <div className="text-5xl font-bold text-red-500 my-2 leading-none tabular-nums">
                {countdown}
              </div>
              <div className="flex gap-2 justify-center mt-3">
                <button
                  type="button"
                  onClick={() => {
                    if (nextLessonUrl) navigate(nextLessonUrl);
                  }}
                  className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium transition"
                >
                  Continue Now →
                </button>
                <button
                  type="button"
                  onClick={() => setCountdown(null)}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-md text-sm font-medium transition"
                >
                  Stay Here
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  },
);

export default StorylinePlayer;
