import { redirect } from "react-router";
import { Link, useLoaderData } from "react-router";
import { Toast } from "../components/Toast";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { getAccessibleCourseIds } from "../utils/access.server";
import { getLatestVideos, toVideo, type YouTubeVideo } from "../utils/youtube.server";
import { useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Award,
  Play,
  Gift,
  Key,
  Lock,
  Video,
  ExternalLink,
} from "lucide-react";

const YOUTUBE_URL = "https://www.youtube.com/@TeachMeLikeATot";
/** Where "Learn More" on a not-enrolled course sends the learner (the store). */
const COURSE_INFO_URL = "https://instructionalgraphics.org/collections/all-products";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  // Redirect admin to admin dashboard
  if (user.role === "ADMIN") return redirect("/");

  // Entitlement first, then progress/enrollment rows scoped to those courses —
  // a revoked licence drops the course from the dashboard immediately.
  const accessibleIds = await getAccessibleCourseIds(user.id);
  const [progresses, enrollments] = await Promise.all([
    prisma.progress.findMany({
      where: { userId: user.id, courseId: { in: accessibleIds } },
      include: { course: { select: { id: true, title: true, summary: true, thumbnailUrl: true, courseType: true, category: true } } },
      orderBy: { lastAccessedAt: "desc" },
    }),
    prisma.enrollment.findMany({
      where: { userId: user.id, courseId: { in: accessibleIds } },
      include: { course: { select: { id: true, title: true, summary: true, thumbnailUrl: true, courseType: true, category: true } } },
      orderBy: { enrolledAt: "desc" },
    }),
  ]);

  // Merge: progress + enrollments that may not have progress yet
  const progressMap = new Map(progresses.map((p) => [p.courseId, p]));
  const enrollmentMap = new Map(enrollments.map((e) => [e.courseId, e]));

  // Combined unique course IDs
  const allCourseIds = new Set([
    ...progresses.map((p) => p.courseId),
    ...enrollments.map((e) => e.courseId),
  ]);

  interface MyCourse {
    courseId: string;
    course: any;
    completionPercent: number;
    isCompleted: boolean;
    hasCertificate: boolean;
    lastAccessedAt: Date | null;
  }

  const myCourses: MyCourse[] = Array.from(allCourseIds).map((courseId) => {
    const progress = progressMap.get(courseId);
    const enrollment = enrollmentMap.get(courseId);
    const course = progress?.course || enrollment?.course;
    return {
      courseId,
      course,
      completionPercent: progress?.completionPercent ?? 0,
      isCompleted: progress?.isCompleted ?? false,
      // A certificate, once earned, stays available (completedAt is never cleared).
      hasCertificate: !!progress?.completedAt,
      lastAccessedAt:
        progress?.lastAccessedAt || enrollment?.enrolledAt || null,
    };
  });

  // Sort by lastAccessedAt desc
  myCourses.sort((a, b) => {
    const aTime = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
    const bTime = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
    return bTime - aTime;
  });

  const hasCertificates = myCourses.some((c) => c.hasCertificate);

  // "Pick up where you left off": the first unfinished course, and inside it
  // the first lesson not yet completed (so the card can say "Module 1 • …").
  const resumeCourse =
    myCourses.find((c) => !c.isCompleted && c.completionPercent > 0) ||
    myCourses.find((c) => !c.isCompleted && c.completionPercent === 0) ||
    null;

  let resumeNext: { moduleIndex: number; moduleTitle: string; lessonId: string | null } | null = null;
  if (resumeCourse) {
    const [modules, done] = await Promise.all([
      prisma.module.findMany({
        where: { courseId: resumeCourse.courseId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
          title: true,
          lessons: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], select: { id: true } },
        },
      }),
      prisma.lessonProgress.findMany({
        where: { userId: user.id, isCompleted: true, lesson: { module: { courseId: resumeCourse.courseId } } },
        select: { lessonId: true },
      }),
    ]);
    const doneSet = new Set(done.map((d) => d.lessonId));
    outer: for (let i = 0; i < modules.length; i++) {
      for (const l of modules[i].lessons) {
        if (!doneSet.has(l.id)) {
          resumeNext = { moduleIndex: i + 1, moduleTitle: modules[i].title, lessonId: l.id };
          break outer;
        }
      }
    }
    if (!resumeNext && modules.length) {
      resumeNext = { moduleIndex: 1, moduleTitle: modules[0].title, lessonId: null };
    }
  }

  // Display conditions (#4): enrolled courses first, then every other
  // published course as a "Not Enrolled" tile so the learner can discover it.
  const owned = new Set(myCourses.map((c) => c.courseId));
  const others = await prisma.course.findMany({
    where: { status: "PUBLISHED", id: { notIn: Array.from(owned) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, summary: true, thumbnailUrl: true, courseType: true, category: true },
  });
  const tiles = [
    ...myCourses.map((c) => ({ ...c, isEnrolled: true as const })),
    ...others.map((course) => ({
      courseId: course.id,
      course,
      completionPercent: 0,
      isCompleted: false,
      hasCertificate: false,
      lastAccessedAt: null as Date | null,
      isEnrolled: false as const,
    })),
  ];

  // Admin-picked videos win; with none configured we fall back to the
  // channel's latest uploads so the section is never empty.
  // A missing WatchVideo table means migrations have not been applied yet.
  // The dashboard is the learner's home page, so degrade to the channel feed
  // instead of taking the whole page down over an optional section.
  const curated = await prisma.watchVideo
    .findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      take: 3,
      select: { videoId: true, title: true },
    })
    .catch((err: unknown) => {
      console.error("[dashboard] WatchVideo lookup failed:", err);
      return [] as Array<{ videoId: string; title: string }>;
    });
  const latestVideos: YouTubeVideo[] =
    curated.length > 0
      ? curated.map((v) => toVideo({ id: v.videoId, title: v.title }))
      : await getLatestVideos(3);

  return {
    user,
    myCourses,
    tiles,
    hasCertificates,
    resumeCourseId: resumeCourse?.courseId ?? null,
    resumeNext,
    latestVideos,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StudentDashboard() {
  const { user, myCourses, tiles, hasCertificates, resumeCourseId, resumeNext, latestVideos } =
    useLoaderData<typeof loader>();

  const resume = resumeCourseId
    ? myCourses.find((c) => c.courseId === resumeCourseId) ?? null
    : null;

  const firstName = user.name.split(" ")[0];

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar
          user={user}
          active="dashboard"
          certificatesEnabled={hasCertificates}
        />

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0">
          <StudentMobileTopbar active="dashboard" />
          <StudentTopbar
            user={user}
            title={`Look who’s back, ${firstName}!`}
            subtitle="Ready for another money “aha!” moment?"
          />

          <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">

            {/* Greeting for phones/tablets — the desktop top bar carries it on lg+ */}
            <div className="lg:hidden mb-6">
              <h1 className="font-display text-2xl sm:text-3xl text-brand-navy leading-tight">
                Look who’s back, {firstName}!
              </h1>
              <p className="text-black text-sm mt-1">Ready for another money “aha!” moment?</p>
            </div>

            {/* ── Hero row: resume card + narrator ─────────────────────────── */}
            <div className="flex items-start gap-4 lg:gap-6 mb-4">
              <div className="flex-1 min-w-0">
                {resume ? (
                  <ResumeCard
                    course={resume}
                    next={resumeNext}
                  />
                ) : (
                  <StartCard hasCourses={myCourses.length > 0} />
                )}
              </div>
              <img
                src="/std-dashboard-img/dashboard narrator.png"
                alt=""
                aria-hidden="true"
                className="hidden md:block w-52 lg:w-72 xl:w-[22rem] 2xl:w-96 shrink-0 -mt-4 lg:-mt-8 -mb-16 lg:-mb-24 pointer-events-none select-none"
              />
            </div>

            {/* ── Your Learning ────────────────────────────────────────────── */}
            <section id="my-courses" className="mb-10 scroll-mt-6 relative z-10">
              <h2 className="font-display text-2xl text-brand-navy mb-4">Your Learning</h2>

              {tiles.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed border-brand-beige-dark rounded-2xl bg-white">
                  <BookOpen className="mx-auto text-brand-navy/30 w-12 h-12 mb-3" />
                  <p className="text-brand-navy font-medium">No courses yet</p>
                  <p className="text-brand-navy/60 text-sm mt-1">
                    Enter the license key from your purchase to unlock your
                    first course.
                  </p>
                  <div className="flex items-center justify-center gap-3 mt-4">
                    <Link
                      to="/catalog"
                      className="inline-flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
                    >
                      <Gift size={14} /> Browse Courses
                    </Link>
                    <Link
                      to="/redeem"
                      className="inline-flex items-center gap-2 border border-brand-beige-dark hover:border-brand-navy text-brand-navy text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                    >
                      <Key size={14} /> Redeem Key
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
                  {tiles.map((c) => (
                    <CourseCard key={c.courseId} c={c} />
                  ))}
                </div>
              )}
            </section>

            {/* ── Watch & Learn ────────────────────────────────────────────── */}
            <WatchAndLearn videos={latestVideos} />
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Resume card ───────────────────────────────────────────────────────────────

function ResumeCard({
  course,
  next,
}: {
  course: any;
  next: { moduleIndex: number; moduleTitle: string; lessonId: string | null } | null;
}) {
  const href = next?.lessonId
    ? `/student/course/${course.courseId}?lesson=${next.lessonId}`
    : `/student/course/${course.courseId}`;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-brand-navy-deeper shadow-lg">
      <ChartDecoration />

      <div className="relative p-4 sm:p-6 flex flex-col sm:flex-row gap-4 sm:gap-6 items-start">
        {/* Thumbnail */}
        <div className="w-full sm:w-40 aspect-video sm:aspect-[4/3] shrink-0 rounded-xl overflow-hidden bg-brand-navy-dark border border-white/10">
          {course.course?.thumbnailUrl ? (
            <img
              src={course.course.thumbnailUrl}
              alt={course.course?.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <BookOpen className="text-white/40 w-8 h-8" />
            </div>
          )}
        </div>

        {/* Copy */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand-mustard mb-1.5">
            PICK UP WHERE YOU LEFT OFF
          </p>
          <h2 className="font-display text-xl sm:text-2xl text-white leading-snug line-clamp-2">
            {course.course?.title}
          </h2>
          {next && (
            <p className="text-white/70 text-sm mt-1">
              Module {next.moduleIndex}
              <span className="mx-1.5">•</span>
              {next.moduleTitle}
            </p>
          )}

          <div className="flex items-center gap-3 mt-4 mb-4">
            <div className="flex-1 max-w-[220px] h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-mustard"
                style={{ width: `${Math.max(2, course.completionPercent)}%` }}
              />
            </div>
            <span className="text-white/70 text-xs font-medium whitespace-nowrap">
              {course.completionPercent}% complete
            </span>
          </div>

          <Link
            to={href}
            className="inline-flex items-center gap-2 bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold px-5 py-2.5 rounded-lg transition-colors text-sm"
          >
            <Play size={14} className="fill-current" />
            {course.completionPercent > 0 ? "Continue Learning" : "Start Course"}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Faded candlestick chart in the card's right half (pure SVG, no asset). */
function ChartDecoration() {
  const bars = [
    [12, 40, 18], [30, 52, 22], [48, 34, 26], [66, 60, 16], [84, 44, 30],
    [102, 70, 20], [120, 56, 24], [138, 80, 14], [156, 64, 28], [174, 90, 18],
    [192, 74, 22], [210, 100, 16], [228, 84, 26], [246, 110, 20], [264, 96, 24],
  ];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 280 140"
      preserveAspectRatio="xMaxYMax slice"
      className="absolute inset-y-0 right-0 w-1/2 h-full opacity-[0.18] text-brand-mustard"
    >
      {/* rising trend line */}
      <polyline
        points="0,120 40,104 80,110 120,86 160,92 200,64 240,70 280,40"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      {bars.map(([x, top, h], i) => (
        <g key={i} stroke="currentColor" fill={i % 3 === 1 ? "none" : "currentColor"}>
          <line x1={x + 4} y1={top - 10} x2={x + 4} y2={top + h + 10} strokeWidth="1" />
          <rect x={x} y={top} width="8" height={h} strokeWidth="1" rx="1" />
        </g>
      ))}
    </svg>
  );
}

// ── Start card (no course in progress) ───────────────────────────────────────

function StartCard({ hasCourses }: { hasCourses: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-brand-navy-deeper shadow-lg">
      <ChartDecoration />
      <div className="relative p-6 sm:p-8">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand-mustard mb-1.5">
          {hasCourses ? "ALL CAUGHT UP" : "LET’S GET STARTED"}
        </p>
        <h2 className="font-display text-xl sm:text-2xl text-white leading-snug">
          {hasCourses
            ? "You’ve finished everything on your list."
            : "Pick your first course and start learning."}
        </h2>
        <p className="text-white/70 text-sm mt-1 max-w-md">
          {hasCourses
            ? "Browse the catalog for your next money “aha!” moment."
            : "Every course unlocks with the license key from your purchase."}
        </p>
        <div className="flex flex-wrap items-center gap-3 mt-5">
          <Link
            to="/catalog"
            className="inline-flex items-center gap-2 bg-brand-mustard hover:bg-brand-mustard/90 text-brand-navy-deeper font-semibold px-5 py-2.5 rounded-lg transition-colors text-sm"
          >
            <Gift size={14} /> Browse Courses
          </Link>
          <Link
            to="/redeem"
            className="inline-flex items-center gap-2 border border-white/30 hover:border-white text-white font-medium px-5 py-2.5 rounded-lg transition-colors text-sm"
          >
            <Key size={14} /> Redeem Key
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Course card ───────────────────────────────────────────────────────────────

function CourseCard({ c }: { c: any }) {
  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark p-3 hover:border-brand-navy/30 hover:shadow-sm transition-all group flex flex-col">
      <div className="aspect-video rounded-xl bg-brand-beige-dark relative overflow-hidden">
        {c.course?.thumbnailUrl ? (
          <img
            src={c.course.thumbnailUrl}
            alt={c.course?.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <BookOpen className="text-brand-navy/30 w-10 h-10" />
          </div>
        )}
        {c.isCompleted && (
          <div className="absolute top-2.5 right-2.5 bg-brand-green text-white rounded-full px-2.5 py-1 flex items-center gap-1 shadow-sm">
            <CheckCircle2 size={11} />
            <span className="text-[10px] font-semibold uppercase tracking-wider">Done</span>
          </div>
        )}
        {c.course?.courseType === "FREE" && (
          <div className="absolute top-2.5 left-2.5 bg-brand-green-dark text-white rounded-full px-2.5 py-1 flex items-center gap-1 shadow-sm">
            <Gift size={10} />
            <span className="text-[10px] font-semibold uppercase tracking-wider">Free</span>
          </div>
        )}
        {!c.isEnrolled && (
          <div className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full bg-brand-navy-deeper/85 text-white flex items-center justify-center shadow-sm">
            <Lock size={14} />
          </div>
        )}
      </div>

      <div className="px-2 pt-4 pb-2 flex flex-col flex-1">
        <h3 className="font-bold text-brand-navy leading-snug line-clamp-2 mb-3">
          {c.course?.title}
        </h3>

        {c.isEnrolled ? (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-brand-navy/60 mb-1.5">
              <span className="font-medium">Progress</span>
              <span className="font-semibold text-brand-navy">{c.completionPercent}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-brand-beige-dark overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-green transition-all"
                style={{ width: `${Math.max(2, c.completionPercent)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mb-4">
            {c.course?.summary && (
              <p className="text-brand-navy/70 text-sm leading-relaxed line-clamp-2 mb-3">
                {c.course.summary}
              </p>
            )}
            <span className="inline-block text-[11px] font-medium text-brand-navy/60 bg-brand-beige border border-brand-beige-dark rounded-md px-2 py-0.5">
              Not Enrolled
            </span>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between">
          {c.isEnrolled ? (
            <Link
              to={`/student/course/${c.courseId}`}
              className="inline-flex items-center gap-1.5 bg-brand-navy-deeper hover:bg-brand-navy text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              <Video size={13} /> Continue
            </Link>
          ) : (
            // Not enrolled: "Learn More" goes to the store.
            <a
              href={COURSE_INFO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-brand-navy-deeper hover:bg-brand-navy text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              <Lock size={12} /> Learn More
            </a>
          )}
          {c.hasCertificate && (
            <a
              href={`/certificate/${c.courseId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-brand-mustard hover:text-brand-mustard/80 text-xs font-semibold transition-colors"
            >
              <Award size={13} /> Certificate
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Watch & Learn banner ─────────────────────────────────────────────────────

function WatchAndLearn({ videos }: { videos: YouTubeVideo[] }) {
  return (
    <section className="rounded-2xl bg-[#E4EFE6] border border-brand-green/20 p-4 sm:p-6">
      <div className="flex flex-col md:flex-row gap-5 md:gap-6 md:items-center">
        {/* Left: pitch */}
        <div className="md:w-60 lg:w-72 shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <a
              href={YOUTUBE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-11 h-11 rounded-full bg-brand-green-dark text-white flex items-center justify-center shrink-0 hover:bg-brand-green transition-colors"
              aria-label="Open the Teach Me Like a Tot YouTube channel"
            >
              <Play size={18} className="fill-current ml-0.5" />
            </a>
            <h2 className="font-display text-2xl text-brand-navy leading-none">Watch &amp; Learn</h2>
          </div>
          <p className="text-brand-navy/70 text-sm leading-relaxed mb-4">
            Quick money and market lessons when you have a few minutes.
          </p>
          <a
            href={YOUTUBE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-brand-navy-deeper hover:bg-brand-navy text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
          >
            Visit YouTube Channel <ExternalLink size={14} />
          </a>
        </div>

        {/* Middle: latest videos — real YouTube players (click to play inline) */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-brand-navy/70 mb-2">Latest Videos</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {videos.map((v) => (
              <VideoTile key={v.id} video={v} />
            ))}
          </div>
        </div>

        {/* Right: tagline */}
        <div className="hidden xl:block shrink-0 w-32 text-right">
          <p className="font-display italic text-brand-navy/80 text-lg leading-snug -rotate-3">
            Real Topics.
            <br />
            Real Life.
            <br />
            Real You.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * "Lite" YouTube embed: shows the thumbnail with a play button and only loads
 * the (heavy) iframe player after the learner clicks - keeps the dashboard
 * fast and avoids three YouTube players spinning up on every visit.
 */
function VideoTile({ video }: { video: YouTubeVideo }) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="min-w-0">
      <div className="relative aspect-video rounded-lg overflow-hidden bg-black shadow-sm">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&modestbranding=1`}
            title={video.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play: ${video.title}`}
            className="group absolute inset-0 w-full h-full"
          >
            <img
              src={video.thumbnail}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
            />
            <span className="absolute inset-0 bg-black/10 group-hover:bg-black/20 transition-colors" />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="w-11 h-11 rounded-full bg-brand-navy-deeper/90 text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                <Play size={18} className="fill-current ml-0.5" />
              </span>
            </span>
          </button>
        )}
      </div>
      <a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block mt-2 text-xs sm:text-[13px] font-semibold text-brand-navy leading-snug line-clamp-2 hover:text-brand-green-dark transition-colors"
      >
        {video.title}
      </a>
    </div>
  );
}
