import { data, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import {
  parseYouTubeId,
  fetchVideoTitle,
  getLatestVideos,
  YOUTUBE_CHANNEL_URL,
} from "../utils/youtube.server";
import {
  Youtube,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Download,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const [videosResult, latest] = await Promise.all([
    // The table arrives with a migration; say so plainly rather than 500ing.
    prisma.watchVideo
      .findMany({ orderBy: [{ order: "asc" }, { createdAt: "asc" }] })
      .then((rows) => ({ rows, ready: true }))
      .catch((err: unknown) => {
        console.error("[watch-videos] WatchVideo table unavailable:", err);
        return { rows: [] as Awaited<ReturnType<typeof prisma.watchVideo.findMany>>, ready: false };
      }),
    // Shown as one-click suggestions from the channel.
    getLatestVideos(6).catch(() => []),
  ]);
  return {
    videos: videosResult.rows,
    tableReady: videosResult.ready,
    latest,
    channelUrl: YOUTUBE_CHANNEL_URL,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "add") {
    const raw = String(formData.get("url") || "");
    const videoId = parseYouTubeId(raw);
    if (!videoId) {
      return data(
        { error: "That doesn't look like a YouTube link. Paste a watch/share/embed URL or the video id." },
        { status: 400 },
      );
    }
    const exists = await prisma.watchVideo.findFirst({ where: { videoId }, select: { id: true } });
    if (exists) {
      return data({ error: "That video is already on the list." }, { status: 409 });
    }
    // Title from the form, or fetched from YouTube when left blank.
    const typed = String(formData.get("title") || "").trim();
    const title = typed || (await fetchVideoTitle(videoId)) || "Untitled video";
    const last = await prisma.watchVideo.findFirst({
      orderBy: { order: "desc" },
      select: { order: true },
    });
    await prisma.watchVideo.create({
      data: { videoId, title, order: (last?.order ?? -1) + 1 },
    });
    return data({ success: `Added "${title}".` });
  }

  const id = String(formData.get("id") || "");

  if (intent === "delete") {
    const r = await prisma.watchVideo.deleteMany({ where: { id } });
    if (r.count === 0) return data({ error: "Video not found." }, { status: 404 });
    return data({ success: "Video removed." });
  }

  if (intent === "toggle") {
    const row = await prisma.watchVideo.findUnique({ where: { id }, select: { isActive: true } });
    if (!row) return data({ error: "Video not found." }, { status: 404 });
    await prisma.watchVideo.update({ where: { id }, data: { isActive: !row.isActive } });
    return data({ success: row.isActive ? "Video hidden." : "Video shown." });
  }

  if (intent === "move") {
    const dir = formData.get("direction") === "up" ? -1 : 1;
    const list = await prisma.watchVideo.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const idx = list.findIndex((v) => v.id === id);
    if (idx === -1) return data({ error: "Video not found." }, { status: 404 });
    const to = idx + dir;
    if (to >= 0 && to < list.length) [list[idx], list[to]] = [list[to], list[idx]];
    // Renumber the whole list so the order column stays a clean 0..n-1.
    await prisma.$transaction(
      list.map((v, i) => prisma.watchVideo.update({ where: { id: v.id }, data: { order: i } })),
    );
    return data({ success: "Order updated." });
  }

  if (intent === "import_latest") {
    const latest = await getLatestVideos(3);
    if (latest.length === 0) {
      return data({ error: "Could not reach YouTube. Try again in a moment." }, { status: 502 });
    }
    const existing = new Set(
      (await prisma.watchVideo.findMany({ select: { videoId: true } })).map((v) => v.videoId),
    );
    const fresh = latest.filter((v) => !existing.has(v.id));
    if (fresh.length === 0) {
      return data({ error: "The latest videos are already on the list." }, { status: 409 });
    }
    const last = await prisma.watchVideo.findFirst({
      orderBy: { order: "desc" },
      select: { order: true },
    });
    let order = (last?.order ?? -1) + 1;
    await prisma.watchVideo.createMany({
      data: fresh.map((v) => ({ videoId: v.id, title: v.title, order: order++ })),
    });
    return data({ success: `Imported ${fresh.length} video${fresh.length === 1 ? "" : "s"}.` });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type Result = { error?: string; success?: string };

export default function WatchVideosPage() {
  const { videos, tableReady, latest, channelUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<Result>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const activeCount = videos.filter((v) => v.isActive).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Youtube size={22} className="text-red-600" />
            Watch &amp; Learn
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Videos shown in the &ldquo;Watch &amp; Learn&rdquo; strip on the student dashboard.
          </p>
        </div>
        <a
          href={channelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-gray-600 border border-gray-300 hover:bg-gray-50 px-3 py-2 rounded-lg transition-colors"
        >
          Open channel <ExternalLink size={13} />
        </a>
      </div>

      {!tableReady && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-4 py-3 text-sm">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <span>
            <strong>Database not migrated yet.</strong> The table that stores these videos does not
            exist on this server. Run <code className="font-mono">npm run migrate:prod</code> (or
            restart the app — it migrates on boot). Until then the student dashboard shows the
            channel&rsquo;s latest uploads automatically.
          </span>
        </div>
      )}

      {result?.error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          <AlertCircle size={15} className="shrink-0" /> {result.error}
        </div>
      )}
      {result?.success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 text-sm">
          <CheckCircle2 size={15} className="shrink-0" /> {result.success}
        </div>
      )}

      {/* Add form */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Add a video</h2>
        <fetcher.Form method="post" className="flex flex-col sm:flex-row gap-3">
          <input type="hidden" name="intent" value="add" />
          <input
            name="url"
            required
            placeholder="https://www.youtube.com/watch?v=… (or a share / embed link)"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            name="title"
            placeholder="Title (optional — fetched from YouTube)"
            className="sm:w-72 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex items-center justify-center gap-2 bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors shrink-0"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
          </button>
        </fetcher.Form>
        <p className="text-[11px] text-gray-400 mt-2">
          Accepts youtube.com/watch, youtu.be, /embed, /shorts, a full &lt;iframe&gt; snippet, or a bare video id.
        </p>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-900">
            Video list{" "}
            <span className="font-normal text-gray-500">
              ({activeCount} shown of {videos.length})
            </span>
          </h2>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="import_latest" />
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-60"
            >
              <Download size={13} /> Import 3 latest from channel
            </button>
          </fetcher.Form>
        </div>

        {videos.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Youtube size={32} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-600 font-medium">No videos picked yet</p>
            <p className="text-gray-500 text-sm mt-1 max-w-md mx-auto">
              While this list is empty the student dashboard automatically shows the
              three most recent uploads from the channel. Add videos here to control
              exactly what appears.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {videos.map((v, i) => (
              <li
                key={v.id}
                className={`flex items-center gap-4 px-4 sm:px-5 py-3 ${v.isActive ? "" : "bg-gray-50"}`}
              >
                <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                <img
                  src={`https://i.ytimg.com/vi/${v.videoId}/default.jpg`}
                  alt=""
                  className={`w-24 h-14 object-cover rounded shrink-0 ${v.isActive ? "" : "opacity-50"}`}
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${v.isActive ? "text-gray-900" : "text-gray-500"}`}>
                    {v.title}
                  </p>
                  <a
                    href={`https://www.youtube.com/watch?v=${v.videoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-400 hover:text-blue-600 font-mono"
                  >
                    {v.videoId} <ExternalLink size={10} className="inline" />
                  </a>
                  {!v.isActive && (
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      hidden
                    </span>
                  )}
                </div>

                {/* Reorder */}
                <fetcher.Form method="post" className="flex items-center shrink-0">
                  <input type="hidden" name="intent" value="move" />
                  <input type="hidden" name="id" value={v.id} />
                  <button
                    type="submit"
                    name="direction"
                    value="up"
                    disabled={i === 0}
                    title="Move up"
                    className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    type="submit"
                    name="direction"
                    value="down"
                    disabled={i === videos.length - 1}
                    title="Move down"
                    className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronDown size={15} />
                  </button>
                </fetcher.Form>

                {/* Show / hide */}
                <fetcher.Form method="post" className="shrink-0">
                  <input type="hidden" name="intent" value="toggle" />
                  <input type="hidden" name="id" value={v.id} />
                  <button
                    type="submit"
                    title={v.isActive ? "Hide from dashboard" : "Show on dashboard"}
                    className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                  >
                    {v.isActive ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                </fetcher.Form>

                {/* Delete */}
                <fetcher.Form method="post" className="shrink-0">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={v.id} />
                  <button
                    type="submit"
                    title="Remove"
                    onClick={(e) => {
                      if (!confirm(`Remove "${v.title}" from Watch & Learn?`)) e.preventDefault();
                    }}
                    className="p-1.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 size={15} />
                  </button>
                </fetcher.Form>
              </li>
            ))}
          </ul>
        )}

        <p className="px-5 py-3 border-t border-gray-100 text-xs text-gray-500">
          The dashboard shows the first <strong>3 visible</strong> videos in this order.
        </p>
      </div>

      {/* Suggestions from the channel */}
      {latest.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Recent uploads</h2>
          <p className="text-xs text-gray-500 mb-4">One click to add any of these.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {latest.map((v) => {
              const added = videos.some((x) => x.videoId === v.id);
              return (
                <fetcher.Form method="post" key={v.id} className="min-w-0">
                  <input type="hidden" name="intent" value="add" />
                  <input type="hidden" name="url" value={v.url} />
                  <input type="hidden" name="title" value={v.title} />
                  <button
                    type="submit"
                    disabled={added || busy}
                    className="group w-full text-left disabled:cursor-not-allowed"
                  >
                    <div className="relative aspect-video rounded-lg overflow-hidden bg-gray-100">
                      <img
                        src={v.thumbnail}
                        alt=""
                        loading="lazy"
                        className={`w-full h-full object-cover ${added ? "opacity-40" : "group-hover:scale-105 transition-transform"}`}
                      />
                      {added ? (
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wider text-gray-600 bg-white/70">
                          Added
                        </span>
                      ) : (
                        <span className="absolute inset-0 items-center justify-center hidden group-hover:flex bg-black/30">
                          <span className="bg-white text-gray-900 rounded-full px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1">
                            <Plus size={11} /> Add
                          </span>
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-600 mt-1.5 line-clamp-2 leading-snug">{v.title}</p>
                  </button>
                </fetcher.Form>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
