import { redirect } from "react-router";
import { Link, useLoaderData, Form } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import {
  BookOpen,
  Clock,
  CheckCircle2,
  Award,
  Play,
  LogOut,
  Search,
  Gift,
  Key,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  // Redirect admin to admin dashboard
  if (user.role === "ADMIN") return redirect("/");

  const [progresses, enrollments] = await Promise.all([
    prisma.progress.findMany({
      where: { userId: user.id },
      include: { course: true },
      orderBy: { lastAccessedAt: "desc" },
    }),
    prisma.enrollment.findMany({
      where: { userId: user.id },
      include: { course: true },
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

  return { user, myCourses };
}

export default function StudentDashboard() {
  const { user, myCourses } = useLoaderData<typeof loader>();

  const completed = myCourses.filter((p) => p.isCompleted).length;
  const inProgress = myCourses.filter(
    (p) => !p.isCompleted && p.completionPercent > 0,
  ).length;

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#008060] flex items-center justify-center shadow-lg shadow-green-900/30">
              <BookOpen className="text-white w-4 h-4" />
            </div>
            <span className="font-bold text-white text-lg">
              InstructionalGraphics
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/catalog"
              className="flex items-center gap-1.5 text-slate-400 hover:text-[#00c896] transition-colors text-sm"
            >
              <Search size={15} /> Browse Courses
            </Link>
            <span className="text-slate-400 text-sm hidden sm:block">
              {user.email}
            </span>
            <Form method="post" action="/auth/logout">
              <button
                type="submit"
                className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors text-sm"
              >
                <LogOut size={16} /> Sign out
              </button>
            </Form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Welcome */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-white">
            Welcome back, {user.name.split(" ")[0]}!
          </h1>
          <p className="text-slate-400 mt-1">
            Continue learning where you left off.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          {[
            {
              label: "Enrolled",
              value: myCourses.length,
              icon: BookOpen,
              color: "text-blue-400",
              bg: "bg-blue-500/10 border-blue-500/20",
            },
            {
              label: "Completed",
              value: completed,
              icon: CheckCircle2,
              color: "text-green-400",
              bg: "bg-green-500/10 border-green-500/20",
            },
            {
              label: "In Progress",
              value: inProgress,
              icon: Clock,
              color: "text-amber-400",
              bg: "bg-amber-500/10 border-amber-500/20",
            },
          ].map((s) => (
            <div key={s.label} className={`rounded-xl border p-5 ${s.bg}`}>
              <s.icon className={`${s.color} w-6 h-6 mb-2`} />
              <p className="text-2xl font-bold text-white">{s.value}</p>
              <p className="text-slate-400 text-sm">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Continue Learning Hero */}
        {(() => {
          const resume =
            myCourses.find((c) => !c.isCompleted && c.completionPercent > 0) ||
            myCourses.find((c) => !c.isCompleted && c.completionPercent === 0);
          if (!resume) return null;
          return (
            <div className="mb-10 rounded-2xl overflow-hidden border border-slate-700 bg-slate-900 shadow-xl relative">
              {/* Background thumbnail blur */}
              {resume.course?.thumbnailUrl && (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-10 scale-105"
                  style={{ backgroundImage: `url(${resume.course.thumbnailUrl})` }}
                />
              )}
              <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-6 p-7">
                {/* Thumbnail */}
                <div className="w-24 h-24 sm:w-28 sm:h-28 flex-shrink-0 rounded-xl overflow-hidden bg-slate-800 border border-slate-700">
                  {resume.course?.thumbnailUrl ? (
                    <img
                      src={resume.course.thumbnailUrl}
                      alt={resume.course?.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <BookOpen className="text-slate-600 w-8 h-8" />
                    </div>
                  )}
                </div>
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[#00c896] mb-1">
                    {resume.completionPercent > 0 ? "Continue Learning" : "Up Next"}
                  </p>
                  <h2 className="text-xl font-bold text-white leading-snug line-clamp-2 mb-3">
                    {resume.course?.title}
                  </h2>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex-1 max-w-xs h-2 rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#008060] transition-all"
                        style={{ width: `${resume.completionPercent}%` }}
                      />
                    </div>
                    <span className="text-slate-400 text-xs font-medium whitespace-nowrap">
                      {resume.completionPercent}% complete
                    </span>
                  </div>
                  <Link
                    to={`/student/course/${resume.courseId}`}
                    className="inline-flex items-center gap-2 bg-[#008060] hover:bg-[#006e52] text-white font-semibold px-6 py-2.5 rounded-xl transition-colors shadow-lg shadow-green-900/30 text-sm"
                  >
                    <Play size={15} />
                    {resume.completionPercent > 0 ? "Continue Learning" : "Start Course"}
                  </Link>
                </div>
              </div>
            </div>
          );
        })()}

        {/* My Courses */}
        <div>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-semibold text-white">My Courses</h2>
            <Link
              to="/catalog"
              className="flex items-center gap-2 text-sm text-[#00c896] hover:text-[#00e6ac] transition-colors font-medium"
            >
              <Gift size={14} /> Browse Free Courses
            </Link>
          </div>

          {myCourses.length === 0 ? (
            <div className="text-center py-16 border-2 border-dashed border-slate-800 rounded-2xl">
              <BookOpen className="mx-auto text-slate-600 w-12 h-12 mb-3" />
              <p className="text-slate-400 font-medium">No courses yet</p>
              <p className="text-slate-600 text-sm mt-1">
                Browse free courses or use a license key to unlock a paid
                course.
              </p>
              <div className="flex items-center justify-center gap-3 mt-4">
                <Link
                  to="/catalog"
                  className="inline-flex items-center gap-2 bg-[#008060] hover:bg-[#006e52] text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
                >
                  <Gift size={14} /> Browse Courses
                </Link>
                <Link
                  to="/redeem"
                  className="inline-flex items-center gap-2 border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                >
                  <Key size={14} /> Redeem Key
                </Link>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {myCourses.map((c) => (
                <div
                  key={c.courseId}
                  className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-slate-600 transition-colors group"
                >
                  <div className="h-36 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center relative overflow-hidden">
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
                      <BookOpen className="text-slate-600 w-10 h-10" />
                    )}
                    {c.isCompleted && (
                      <div className="absolute top-3 right-3 bg-green-500/20 border border-green-500/30 rounded-full px-2 py-0.5 flex items-center gap-1">
                        <CheckCircle2 size={11} className="text-green-400" />
                        <span className="text-green-400 text-xs font-medium">
                          Done
                        </span>
                      </div>
                    )}
                    {/* FREE badge */}
                    {c.course?.courseType === "FREE" && (
                      <div className="absolute top-3 left-3 bg-emerald-500/20 border border-emerald-500/30 rounded-full px-2 py-0.5 flex items-center gap-1">
                        <Gift size={10} className="text-emerald-400" />
                        <span className="text-emerald-400 text-[10px] font-semibold uppercase">
                          Free
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="p-5">
                    <h3 className="font-semibold text-white leading-snug line-clamp-2 mb-3 group-hover:text-[#00c896] transition-colors">
                      {c.course?.title}
                    </h3>
                    {/* Progress bar */}
                    <div className="mb-4">
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>Progress</span>
                        <span>{c.completionPercent}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#008060] transition-all"
                          style={{ width: `${c.completionPercent}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <Link
                        to={`/student/course/${c.courseId}`}
                        className="flex items-center gap-1.5 bg-[#008060] hover:bg-[#006e52] text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
                      >
                        <Play size={13} />{" "}
                        {c.completionPercent > 0 ? "Continue" : "Start"}
                      </Link>
                      {c.isCompleted && (
                        <a
                          href={`/certificate/${c.courseId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-amber-400 hover:text-amber-300 text-xs font-medium transition-colors"
                        >
                          <Award size={13} /> Certificate
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Action cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-10">
          <div className="bg-gradient-to-br from-emerald-900/30 to-slate-900 border border-emerald-800/30 rounded-xl p-6">
            <Gift className="text-emerald-400 w-8 h-8 mb-3" />
            <h3 className="text-white font-semibold mb-1">Free Courses</h3>
            <p className="text-slate-400 text-sm mb-4">
              Browse our library of free courses and start learning immediately.
            </p>
            <Link
              to="/catalog"
              className="inline-flex items-center gap-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-sm font-medium px-4 py-2 rounded-lg border border-emerald-500/30 transition-colors"
            >
              Browse Catalog
            </Link>
          </div>

          <div className="bg-gradient-to-br from-amber-900/20 to-slate-900 border border-amber-800/20 rounded-xl p-6">
            <Key className="text-amber-400 w-8 h-8 mb-3" />
            <h3 className="text-white font-semibold mb-1">
              Have a License Key?
            </h3>
            <p className="text-slate-400 text-sm mb-4">
              Redeem your license key to unlock a paid course instantly.
            </p>
            <Link
              to="/redeem"
              className="inline-flex items-center gap-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-sm font-medium px-4 py-2 rounded-lg border border-amber-500/30 transition-colors"
            >
              Redeem Key
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
