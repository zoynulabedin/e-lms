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

const DEFAULT_HOST = "https://courses.instructionalgraphics.org";

/**
 * Embeds a published Storyline scene and reports when the learner reaches its
 * final slide.
 *
 * This component deliberately does NOT advance the learner. It used to start a
 * five-second countdown on `lessonComplete` and navigate on its own, which
 * defeated the whole point of holding "Next Lesson" back until the scene is
 * finished — and auto-jumping is how slides get skipped, which is the problem
 * the gate exists to solve. Moving on is the learner's decision: the course
 * player reveals its own "Next Lesson" button, and the side menu is always
 * available. Do not reintroduce an auto-advance here.
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
          typeof window !== "undefined" ? window.location.origin : DEFAULT_HOST;
        set.add(new URL(src, base).origin);
      } catch {
        // invalid src — fall back to defaults only
      }
      set.add(DEFAULT_HOST);
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
        const payload = event.data;
        if (!payload || typeof payload !== "object") return;
        if (payload.action !== "lessonComplete") return;

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
