/**
 * Open-redirect guard for "?redirect=" values. Pure (no server imports), so
 * it is safe to use anywhere.
 *
 * Only an in-app path is honoured. Checking the raw string is not enough:
 * browsers drop tab/newline from URLs and read "\" as "/", so "/<TAB>/evil.com"
 * and "/\evil.com" both land on evil.com. Those characters are rejected
 * outright, and the result is rebuilt from the parsed URL so dot segments
 * ("/.//evil.com" -> "//evil.com") can't sneak a "//" past the check.
 */
const BASE = "http://safe-redirect.invalid";

// ASCII control characters (U+0000-U+001F, U+007F) and backslashes.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/;

export function safeRedirect(to: unknown, fallback: string): string {
  if (typeof to !== "string" || to === "") return fallback;
  if (UNSAFE_CHARS.test(to)) return fallback;
  if (!to.startsWith("/") || to.startsWith("//")) return fallback;

  let url: URL;
  try {
    url = new URL(to, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  // Re-check after normalisation (see "/.//evil.com" above).
  const path = url.pathname;
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;

  // Bouncing back to login / logout / register is never useful. Route
  // matching ignores case and percent-encoding, so compare the decoded form.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed escapes: check the raw path instead.
  }
  const lower = decoded.toLowerCase();
  if (lower === "/auth" || lower.startsWith("/auth/")) return fallback;

  return path + url.search + url.hash;
}
