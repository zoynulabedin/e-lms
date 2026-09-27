/**
 * "The video has finished" from an embedded YouTube or Vimeo player.
 *
 * Both players report playback events to the embedding page by postMessage
 * once the page asks for them; this file holds the two small protocols.
 * useEmbedEnded does the asking and listening. A native <video> (MP4 or HLS)
 * needs none of this: it has an `ended` event.
 *
 * Kept free of imports so it can be exercised without a browser or bundler.
 */

export type EmbedProvider = "youtube" | "vimeo";

/** Origins each provider's player posts from. Anything else is ignored. */
export const PLAYER_ORIGINS: Record<EmbedProvider, readonly string[]> = {
  youtube: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
  vimeo: ["https://player.vimeo.com"],
};

/** Messages asking the player to report its playback events to this page. */
export function playerSubscribeMessages(provider: EmbedProvider): string[] {
  if (provider === "youtube") {
    // The YouTube IFrame API's own handshake (the embed needs enablejsapi=1).
    return [
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
      JSON.stringify({ event: "command", func: "addEventListener", args: ["onStateChange"], id: 1, channel: "widget" }),
    ];
  }
  // Vimeo's player.js protocol.
  return [JSON.stringify({ method: "addEventListener", value: "ended" })];
}

/**
 * What a message from the player means here: it finished, it has just become
 * ready (subscribe again, an earlier request may have come too soon), or it
 * is some other player event. Null for anything that is not a player message.
 */
export function parsePlayerMessage(provider: EmbedProvider, data: unknown): "ended" | "ready" | "other" | null {
  let msg = data;
  if (typeof msg === "string") {
    // YouTube's infoDelivery messages can be a few KB; nothing real is larger.
    if (msg.length > 50_000) return null;
    try {
      msg = JSON.parse(msg);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (typeof event !== "string") return null;

  if (provider === "youtube") {
    // Player state 0 is "ended", sent as a state change and in info updates.
    if (event === "onStateChange" && info === 0) return "ended";
    if (event === "infoDelivery" && info && typeof info === "object" && (info as { playerState?: unknown }).playerState === 0) {
      return "ended";
    }
    if (event === "onReady" || event === "initialDelivery") return "ready";
    return "other";
  }

  if (event === "ended" || event === "finish") return "ended";
  if (event === "ready") return "ready";
  return "other";
}
