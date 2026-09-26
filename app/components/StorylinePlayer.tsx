import { forwardRef, useEffect, useMemo, useRef } from "react";

interface StorylinePlayerProps {
  /** Storyline iframe src (story.html URL or full embed URL) */
  src: string;
  /** Lesson ID for tracking */
  lessonId: string;
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

/**
 * Embeds a published Storyline scene and reports when the learner reaches its
 * final slide.
 *
 * Navigation remains the parent course player's responsibility. Keeping this
 * component focused on validating the Storyline message lets the parent mark
 * progress, show a cancellable countdown, and choose whether the following
 * curriculum item is safe to open automatically.
 */
export const StorylinePlayer = forwardRef<HTMLIFrameElement, StorylinePlayerProps>(
  function StorylinePlayer(
    {
      src,
      lessonId,
      onComplete,
      allowedOrigins,
      title = "Storyline Course",
      className,
      allow = "autoplay; fullscreen",
      sandbox,
    },
    ref,
  ) {
    // The forwarded ref goes to the parent; this one lets the message handler
    // below confirm a message really came from THIS iframe.
    const innerRef = useRef<HTMLIFrameElement | null>(null);
    const setRefs = (node: HTMLIFrameElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLIFrameElement | null>).current = node;
    };

    const allowedOriginSet = useMemo(() => {
      const set = new Set<string>();
      try {
        // Resolve relative src (e.g. "/storyline/x/story.html") against the
        // page origin so same-origin iframes are accepted too.
        const base =
          typeof window !== "undefined" ? window.location.origin : "http://localhost";
        set.add(new URL(src, base).origin);
      } catch {
        // invalid src — fall back to defaults only
      }
      for (const o of allowedOrigins ?? []) set.add(o);
      return set;
    }, [src, allowedOrigins]);

    useEffect(() => {
      function handleMessage(event: MessageEvent) {
        // The sender must be THIS player's iframe. An origin check alone lets
        // any other frame or tab from an allowed host mark lessons complete.
        const frame = innerRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        if (!allowedOriginSet.has(event.origin)) return;
        let payload = event.data;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            return;
          }
        }
        if (!payload || typeof payload !== "object") return;
        const isCompletion =
          payload.type === "STORYLINE_LESSON_COMPLETED" ||
          // Keep existing published packages working while they are migrated.
          payload.action === "lessonComplete";
        if (!isCompletion) return;

        onComplete?.(lessonId);
      }
      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, [lessonId, onComplete, allowedOriginSet]);

    return (
      <iframe
        ref={setRefs}
        src={src}
        title={title}
        className={className}
        allow={allow}
        sandbox={sandbox}
        allowFullScreen
      />
    );
  },
);

export default StorylinePlayer;
