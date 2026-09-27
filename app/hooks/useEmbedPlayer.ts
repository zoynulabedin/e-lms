import { useEffect, useRef, type RefObject } from "react";
import {
  PLAYER_ORIGINS,
  parsePlayerMessage,
  playerMutedPlayMessages,
  playerSubscribeMessages,
  type EmbedProvider,
} from "../utils/video-playback";
import { storylineDebug } from "../utils/storyline";

/** How long an autoplaying player has to start before it is started muted. */
const AUTOPLAY_GRACE_MS = 2_500;
/** While it is still buffering, look again this often, this many times. */
const AUTOPLAY_RECHECK_MS = 1_500;
const AUTOPLAY_RECHECKS = 6;

/**
 * Talks to the YouTube or Vimeo player in `frameRef`:
 * - calls `onEnded` when its video finishes;
 * - with `autoplay`, starts it muted if it has not started by itself shortly
 *   after loading (the browser blocked playback with sound).
 * Only messages from that iframe's own window and the provider's origin
 * count. Does nothing while `provider` is null.
 */
export function useEmbedPlayer({
  frameRef,
  provider,
  src,
  autoplay = false,
  onEnded,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  provider: EmbedProvider | null;
  /** The iframe's src: a new video re-subscribes. */
  src: string | null;
  /** The embed was asked to autoplay (autoplay=1). */
  autoplay?: boolean;
  onEnded: () => void;
}) {
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const frame = frameRef.current;
    if (!provider || !frame) return;
    const origins = PLAYER_ORIGINS[provider];
    let heard = false;
    // Latest playback state reported by the player.
    let state: "unknown" | "playing" | "buffering" | "paused" | "idle" = "unknown";
    let attempts = 0;
    let rechecks = 0;
    let fallbackTimer: number | undefined;

    // The messages carry nothing private, so any target origin will do; a
    // fixed one would miss the provider's own redirects.
    const post = (messages: string[]) => {
      for (const message of messages) frame.contentWindow?.postMessage(message, "*");
    };
    const subscribe = () => post(playerSubscribeMessages(provider));

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
      if (!heard) {
        heard = true;
        // The player is up. If it was meant to autoplay but has not started,
        // the browser blocked sound: start it muted instead. A player still
        // buffering gets more time; one the learner paused is left alone.
        if (autoplay) {
          const check = () => {
            if (state === "playing" || state === "paused") return;
            if (state === "buffering" && rechecks++ < AUTOPLAY_RECHECKS) {
              fallbackTimer = window.setTimeout(check, AUTOPLAY_RECHECK_MS);
              return;
            }
            storylineDebug("autoplay with sound blocked; starting muted", { provider });
            post(playerMutedPlayMessages(provider));
          };
          fallbackTimer = window.setTimeout(check, AUTOPLAY_GRACE_MS);
        }
      }
      if (signal === "ready") subscribe();
      else if (signal === "playing" || signal === "buffering" || signal === "paused" || signal === "idle") state = signal;
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
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", subscribe);
    };
  }, [frameRef, provider, src, autoplay]);
}
