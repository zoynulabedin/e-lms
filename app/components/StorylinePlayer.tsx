import { forwardRef, useEffect, useMemo, useRef } from "react";
import { parseStorylineMessage, storylineDebug } from "../utils/storyline";

interface StorylinePlayerProps {
  /** Storyline iframe src (story.html URL or full embed URL) */
  src: string;
  /** Lesson ID for tracking */
  lessonId: string;
  /**
   * Called for every validated completion message - `{ type:
   * "STORYLINE_LESSON_COMPLETED" }`, or `{ action: "lessonComplete" }` from
   * older packages. Storyline can repeat it; the caller de-duplicates.
   */
  onComplete?: (lessonId: string) => void;
  /** Called for a validated `{ type: "progress", percent }` message. */
  onProgress?: (percent: number) => void;
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
 * A message is acted on only when it comes from THIS iframe's window, from an
 * allowed origin, and has one of the shapes parseStorylineMessage accepts.
 * This is the only Storyline message listener in the course player.
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
      onProgress,
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

    // Latest callbacks, read by the listener without re-attaching it.
    const handlersRef = useRef({ lessonId, onComplete, onProgress });
    handlersRef.current = { lessonId, onComplete, onProgress };

    // By value: a new array with the same hosts must not rebuild the listener.
    const extraOrigins = (allowedOrigins ?? []).join(",");
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
      for (const o of extraOrigins.split(",")) if (o) set.add(o);
      return set;
    }, [src, extraOrigins]);

    useEffect(() => {
      function handleMessage(event: MessageEvent) {
        // The sender must be THIS player's iframe. An origin check alone lets
        // any other frame or tab from an allowed host mark lessons complete.
        const frame = innerRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        const message = parseStorylineMessage(event.data);
        if (!message) return;
        if (!allowedOriginSet.has(event.origin)) {
          storylineDebug("message rejected: origin not allowed", {
            origin: event.origin,
            allowed: Array.from(allowedOriginSet),
          });
          return;
        }

        const { lessonId: id, onComplete: complete, onProgress: progress } = handlersRef.current;
        if (message.kind === "completed") {
          storylineDebug("completion event received", { lessonId: id, origin: event.origin });
          complete?.(id);
        } else {
          progress?.(message.percent);
        }
      }
      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, [allowedOriginSet]);

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
