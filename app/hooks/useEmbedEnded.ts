import { useEffect, useRef, type RefObject } from "react";
import { PLAYER_ORIGINS, parsePlayerMessage, playerSubscribeMessages, type EmbedProvider } from "../utils/video-ended";
import { storylineDebug } from "../utils/storyline";

/**
 * Calls `onEnded` when the YouTube or Vimeo player in `frameRef` finishes its
 * video. Only messages from that iframe's own window and the provider's
 * origin count. Does nothing while `provider` is null.
 */
export function useEmbedEnded({
  frameRef,
  provider,
  src,
  onEnded,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  provider: EmbedProvider | null;
  /** The iframe's src: a new video re-subscribes. */
  src: string | null;
  onEnded: () => void;
}) {
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const frame = frameRef.current;
    if (!provider || !frame) return;
    const origins = PLAYER_ORIGINS[provider];
    let heard = false;
    let attempts = 0;

    // The messages carry nothing private, so any target origin will do; a
    // fixed one would miss the provider's own redirects.
    const subscribe = () => {
      for (const message of playerSubscribeMessages(provider)) frame.contentWindow?.postMessage(message, "*");
    };

    // The player may not be listening yet when the frame loads: ask again
    // every half second until it answers (or 10 s pass).
    const timer = window.setInterval(() => {
      if (heard || ++attempts > 20) window.clearInterval(timer);
      else subscribe();
    }, 500);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !origins.includes(event.origin)) return;
      const signal = parsePlayerMessage(provider, event.data);
      if (!signal) return;
      heard = true;
      if (signal === "ready") subscribe();
      else if (signal === "ended") {
        storylineDebug("video ended", { provider });
        onEndedRef.current();
      }
    };

    window.addEventListener("message", onMessage);
    frame.addEventListener("load", subscribe);
    subscribe();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", subscribe);
    };
  }, [frameRef, provider, src]);
}
