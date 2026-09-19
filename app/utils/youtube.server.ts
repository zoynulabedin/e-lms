/**
 * Latest videos from the Teach Me Like a Tot YouTube channel.
 *
 * Uses the public RSS feed (no API key, no quota) and caches the result in
 * memory for a few hours so the dashboard loader stays fast. If YouTube is
 * unreachable, the last good result - or a static fallback - is returned so
 * the "Watch & Learn" section never breaks the page.
 */

export const YOUTUBE_CHANNEL_HANDLE = "TeachMeLikeATot";
export const YOUTUBE_CHANNEL_ID = "UCJrFcN5lRfzUQnvCu5Zoeqw";
export const YOUTUBE_CHANNEL_URL = `https://www.youtube.com/@${YOUTUBE_CHANNEL_HANDLE}`;

export type YouTubeVideo = {
  id: string;
  title: string;
  publishedAt: string; // ISO
  thumbnail: string;
  url: string;
};

const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

// Known videos, used only when the feed can't be reached before anything was cached.
const FALLBACK: YouTubeVideo[] = [
  { id: "rdmWpQ0cm_0", title: "The Mutual Funds vs ETFs Debate", publishedAt: "2024-04-21T21:08:45+00:00" },
  { id: "XhJ1EeqaiFI", title: "Tax Implications from Investing", publishedAt: "2024-01-16T23:34:13+00:00" },
  { id: "YGLrqbSu5JU", title: "Importance of Renter's Insurance", publishedAt: "2024-01-16T22:53:29+00:00" },
].map(withUrls);

function withUrls(v: { id: string; title: string; publishedAt: string }): YouTubeVideo {
  return {
    ...v,
    thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  };
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");

function parseFeed(xml: string): YouTubeVideo[] {
  const out: YouTubeVideo[] = [];
  const entries = xml.split("<entry>").slice(1);
  for (const e of entries) {
    const id = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = e.match(/<title>([^<]*)<\/title>/)?.[1];
    const publishedAt = e.match(/<published>([^<]+)<\/published>/)?.[1];
    if (id && title && publishedAt) out.push(withUrls({ id, title: decode(title), publishedAt }));
  }
  // The feed is roughly newest-first, but sort explicitly to be safe.
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

let cache: { at: number; videos: YouTubeVideo[] } | null = null;
let inflight: Promise<YouTubeVideo[]> | null = null;

export async function getLatestVideos(limit = 3): Promise<YouTubeVideo[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.videos.slice(0, limit);

  // Coalesce concurrent loaders into one fetch.
  inflight ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(FEED_URL, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; e-lms dashboard)" },
      });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const videos = parseFeed(await res.text());
      if (videos.length === 0) throw new Error("feed had no entries");
      cache = { at: Date.now(), videos };
      return videos;
    } catch (err) {
      console.warn("[youtube] latest videos unavailable:", (err as Error)?.message);
      // Serve stale data if we have it, otherwise the static fallback.
      return cache?.videos ?? FALLBACK;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return (await inflight).slice(0, limit);
}
