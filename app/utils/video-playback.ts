/**
 * Playback helpers for a Video lesson's player: knowing when an embedded
 * YouTube or Vimeo video has finished, and starting a video that
 * auto-advance opened even where the browser blocks sound.
 *
 * Both embedded players report playback events to the embedding page by
 * postMessage once the page asks for them; this file holds the two small
 * protocols, and useEmbedPlayer does the asking and listening. A native
 * <video> (MP4 or HLS) has an `ended` event and needs none of that.
 *
 * Kept free of imports so it can be exercised without a browser or bundler.
 */

export type EmbedProvider = "youtube" | "vimeo";

/** Origins each provider's player posts from. Anything else is ignored. */
export const PLAYER_ORIGINS: Record<EmbedProvider, readonly string[]> = {
  youtube: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
  vimeo: ["https://player.vimeo.com"],
};

const youtubeCommand = (func: string, args: unknown[] = []) =>
  JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" });

/** Messages asking the player to report its playback events to this page. */
export function playerSubscribeMessages(provider: EmbedProvider): string[] {
  if (provider === "youtube") {
    // The YouTube IFrame API's own handshake (the embed needs enablejsapi=1).
    return [
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
      youtubeCommand("addEventListener", ["onStateChange"]),
    ];
  }
  // Vimeo's player.js protocol.
  return [
    JSON.stringify({ method: "addEventListener", value: "ended" }),
    JSON.stringify({ method: "addEventListener", value: "play" }),
  ];
}

/**
 * Messages that start the player muted. Browsers that block playback with
 * sound until the learner clicks (Edge's "Limit" autoplay setting, for one)
 * always allow it muted; the learner unmutes from the player's own controls.
 */
export function playerMutedPlayMessages(provider: EmbedProvider): string[] {
  if (provider === "youtube") return [youtubeCommand("mute"), youtubeCommand("playVideo")];
  return [
    JSON.stringify({ method: "setMuted", value: true }),
    JSON.stringify({ method: "setVolume", value: 0 }),
    JSON.stringify({ method: "play" }),
  ];
}

export type PlayerSignal = "ended" | "playing" | "buffering" | "paused" | "idle" | "ready" | "other";

/**
 * What a message from the player means here: it finished; it is playing,
 * buffering, paused by the learner, or not started (YouTube reports that
 * last one when the browser blocks autoplay); it has just become ready
 * (subscribe again, an earlier request may have come too soon); or some
 * other player event. Null for anything that is not a player message.
 */
export function parsePlayerMessage(provider: EmbedProvider, data: unknown): PlayerSignal | null {
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
    // Player states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering,
    // 5 cued. They arrive as state changes and inside info updates.
    const state =
      event === "onStateChange"
        ? info
        : event === "infoDelivery" && info && typeof info === "object"
          ? (info as { playerState?: unknown }).playerState
          : undefined;
    if (state === 0) return "ended";
    if (state === 1) return "playing";
    if (state === 3) return "buffering";
    if (state === 2) return "paused";
    if (state === -1 || state === 5) return "idle";
    if (event === "onReady" || event === "initialDelivery") return "ready";
    return "other";
  }

  if (event === "ended" || event === "finish") return "ended";
  if (event === "play" || event === "playing") return "playing";
  if (event === "ready") return "ready";
  return "other";
}

/**
 * Plays `video`, falling back to muted playback where the browser blocks
 * sound without a click. Resolves to how it ended up playing.
 */
export async function playWithMutedFallback(video: HTMLMediaElement): Promise<"sound" | "muted" | "blocked"> {
  try {
    await video.play();
    return "sound";
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "NotAllowedError") return "blocked";
  }
  video.muted = true;
  try {
    await video.play();
    return "muted";
  } catch {
    video.muted = false;
    return "blocked";
  }
}
