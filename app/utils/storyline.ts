/**
 * Storyline → LMS message contract.
 *
 * A published Storyline package only announces that its lesson has finished.
 * The course player decides what that means: save progress, count down, and
 * open the next curriculum item. Storyline never carries an LMS URL. The
 * trigger authors add is documented in STORYLINE_INTEGRATION.md.
 */

/** `type` of the message a Storyline "Execute JavaScript" trigger posts. */
export const STORYLINE_COMPLETED_TYPE = "STORYLINE_LESSON_COMPLETED";

/** Seconds the "Next lesson starts in…" countdown runs before opening it. */
export const STORYLINE_AUTO_ADVANCE_SECONDS = 5;

export type StorylineMessage =
  | { kind: "completed" }
  | { kind: "progress"; percent: number };

/**
 * Reads a postMessage payload. Anything that is not one of these returns null,
 * so a caller never acts on an unknown shape:
 *  - `{ type: "STORYLINE_LESSON_COMPLETED" }`  the current trigger
 *  - `{ action: "lessonComplete" }`            packages published before it
 *  - `{ type: "progress", percent }`           watch percentage (flat courses)
 * The same objects as JSON strings are accepted too; older triggers stringify.
 */
export function parseStorylineMessage(data: unknown): StorylineMessage | null {
  let payload = data;
  if (typeof payload === "string") {
    // A real message is a few dozen characters; don't parse arbitrary blobs.
    if (payload.length > 1_000) return null;
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const msg = payload as Record<string, unknown>;
  if (msg.type === STORYLINE_COMPLETED_TYPE || msg.action === "lessonComplete") {
    return { kind: "completed" };
  }
  if (msg.type === "progress" && typeof msg.percent === "number" && Number.isFinite(msg.percent)) {
    return { kind: "progress", percent: Math.min(100, Math.max(0, msg.percent)) };
  }
  return null;
}

/**
 * Origins from a comma-separated list such as the STORYLINE_ALLOWED_ORIGINS
 * env var. Only http(s) origins survive; paths and malformed entries are
 * dropped rather than widening what the player accepts.
 */
export function parseOriginList(raw: string | null | undefined): string[] {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // not a URL - ignore
    }
  }
  return Array.from(origins);
}

/**
 * Development trace of the Storyline hand-off. Silent in production unless a
 * tester turns it on for their own browser with
 * `localStorage.setItem("storyline-debug", "1")`.
 */
export function storylineDebug(message: string, detail?: Record<string, unknown>) {
  let enabled = import.meta.env.DEV;
  if (!enabled && typeof window !== "undefined") {
    try {
      enabled = window.localStorage.getItem("storyline-debug") === "1";
    } catch {
      // storage blocked - stay silent
    }
  }
  if (!enabled) return;
  if (detail) console.debug(`[storyline] ${message}`, detail);
  else console.debug(`[storyline] ${message}`);
}
