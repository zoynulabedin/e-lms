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
import {
  BookOpen,
  CheckCircle2,
  Award,
  Play,
  Gift,
  Key,
  Sparkles,
  Calendar,
  Hammer,
  ArrowRight,
  Youtube,
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

  const hasCertificates = myCourses.some((c) => c.isCompleted);

  return { user, myCourses, hasCertificates };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StudentDashboard() {
  const { user, myCourses, hasCertificates } = useLoaderData<typeof loader>();

  const enrolled = myCourses.length;
  const completed = myCourses.filter((p) => p.isCompleted).length;
  const active = myCourses.filter(
    (p) => !p.isCompleted && p.completionPercent > 0,
  ).length;

  const resume =
    myCourses.find((c) => !c.isCompleted && c.completionPercent > 0) ||
    myCourses.find((c) => !c.isCompleted && c.completionPercent === 0) ||
    null;

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
          <StudentMobileTopbar />
          <StudentTopbar
            user={user}
            title={`Welcome back, ${firstName}!`}
            subtitle="Continue learning where you left off."
          />

          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 sm:gap-5 mb-10">
              <StatCard
                value={enrolled}
                label="Enrolled"
                sublabel="Courses"
                icon={BookOpen}
                tone="navy"
              />
              <StatCard
                value={completed}
                label="Completed"
                sublabel="Courses"
                icon={CheckCircle2}
                tone="green"
              />
              <StatCard
                value={active}
                label="Active"
                sublabel="Courses"
                icon={Play}
                tone="mustard"
              />
            </div>

            {/* Pick up where you left off */}
            {resume && (
              <div className="mb-10 rounded-2xl overflow-hidden bg-brand-navy shadow-lg relative">
                {resume.course?.thumbnailUrl && (
                  <div
                    className="absolute inset-0 bg-cover bg-center opacity-20"
                    style={{
                      backgroundImage: `url(${resume.course.thumbnailUrl})`,
                    }}
                  />
                )}
                <div className="relative p-6 sm:p-8 flex flex-col sm:flex-row gap-6 items-start sm:items-center">
                  <div className="w-24 h-24 sm:w-28 sm:h-28 shrink-0 rounded-xl overflow-hidden bg-brand-navy-dark border border-white/10">
                    {resume.course?.thumbnailUrl ? (
                      <img
                        src={resume.course.thumbnailUrl}
                        alt={resume.course?.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <BookOpen className="text-white/40 w-8 h-8" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold tracking-[0.18em] text-brand-mustard mb-2">
                      PICK UP WHERE YOU LEFT OFF
                    </p>
                    <h2 className="font-display text-2xl sm:text-3xl text-white leading-snug line-clamp-2 mb-4">
                      {resume.course?.title}
                    </h2>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex-1 max-w-xs h-2 rounded-full bg-white/15 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand-mustard transition-all"
                          style={{ width: `${resume.completionPercent}%` }}
                        />
                      </div>
                      <span className="text-white/70 text-xs font-medium whitespace-nowrap">
                        {resume.completionPercent}% complete
                      </span>
                    </div>
                    <Link
                      to={`/student/course/${resume.courseId}`}
                      className="inline-flex items-center gap-2 bg-brand-mustard hover:bg-brand-mustard/90 text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
                    >
                      <Play size={15} />
                      {resume.completionPercent > 0
                        ? "Continue Learning"
                        : "Start Course"}
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* My Courses */}
            <section className="mb-10">
              <div className="mb-5">
                <h2 className="font-display text-2xl text-brand-navy">My Courses</h2>
              </div>

              {myCourses.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed border-brand-beige-dark rounded-2xl bg-white">
                  <BookOpen className="mx-auto text-brand-navy/30 w-12 h-12 mb-3" />
                  <p className="text-brand-navy font-medium">No courses yet</p>
                  <p className="text-brand-navy/60 text-sm mt-1">
                    Browse free courses or use a license key to unlock a paid
                    course.
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
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                  {myCourses.map((c) => (
                    <CourseCard key={c.courseId} c={c} />
                  ))}
                </div>
              )}
            </section>

            {/* Making Money & Markets Make Sense — YouTube CTA */}
            <section className="mb-10">
              <div className="rounded-2xl overflow-hidden bg-brand-green-dark shadow-lg relative">
                <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-brand-mustard/20 blur-3xl" />
                <div className="relative p-6 sm:p-8 flex flex-col sm:flex-row gap-6 items-start sm:items-center">
                  <div className="shrink-0 w-16 h-16 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center">
                    <Youtube className="text-white w-8 h-8" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-display text-2xl sm:text-3xl text-white leading-tight mb-2">
                      Making Money &amp; Markets Make Sense
                    </h2>
                    <p className="text-white/85 text-sm sm:text-base leading-relaxed mb-4 max-w-2xl">
                      Fast, simple videos that turn confusing money topics into
                      &ldquo;Ohhh&hellip; now I get it.&rdquo;
                    </p>
                    <a
                      href="https://www.youtube.com/@TeachMeLikeATot"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-brand-mustard hover:bg-brand-mustard/90 text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
                    >
                      <Youtube size={16} />
                      Watch on YouTube
                    </a>
                  </div>
                </div>
              </div>
            </section>

            {/* What's New */}
            <section>
              <h2 className="font-display text-2xl text-brand-navy mb-5">
                What's New
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <WhatsNewCard
                  icon={Sparkles}
                  eyebrow="New Lesson Available"
                  cta="Watch Latest Lesson"
                  to={
                    resume
                      ? `/student/course/${resume.courseId}`
                      : "/catalog"
                  }
                  tone="green"
                />
                <WhatsNewCard
                  icon={Calendar}
                  eyebrow="Coming Next"
                  cta="Preview What's Coming"
                  to="/catalog"
                  tone="navy"
                />
                <WhatsNewCard
                  icon={Hammer}
                  eyebrow="In Development"
                  cta="Stay Tuned"
                  to={undefined}
                  tone="mustard"
                />
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  sublabel,
  icon: Icon,
  tone,
}: {
  value: number;
  label: string;
  sublabel: string;
  icon: React.ElementType;
  tone: "navy" | "green" | "mustard";
}) {
  const tones: Record<typeof tone, { iconBg: string; iconColor: string }> = {
    navy: { iconBg: "bg-brand-navy/10", iconColor: "text-brand-navy" },
    green: {
      iconBg: "bg-brand-green/10",
      iconColor: "text-brand-green-dark",
    },
    mustard: {
      iconBg: "bg-brand-mustard/15",
      iconColor: "text-brand-mustard",
    },
  };
  const t = tones[tone];
  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark p-5 sm:p-6">
      <div
        className={`w-10 h-10 rounded-lg ${t.iconBg} flex items-center justify-center mb-3`}
      >
        <Icon className={`${t.iconColor} w-5 h-5`} />
      </div>
      <p className="text-3xl sm:text-4xl font-bold text-brand-navy leading-none">
        {value}
      </p>
      <p className="text-sm font-semibold text-brand-navy mt-2 leading-tight">
        {label}
      </p>
      <p className="text-xs text-brand-navy/60 leading-tight">{sublabel}</p>
    </div>
  );
}

// ── Course card ───────────────────────────────────────────────────────────────

function CourseCard({ c }: { c: any }) {
  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark overflow-hidden hover:border-brand-navy/30 transition-colors group">
      <div className="h-36 bg-brand-beige-dark relative overflow-hidden">
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
          <div className="absolute top-3 right-3 bg-brand-green text-white rounded-full px-2.5 py-1 flex items-center gap-1 shadow-sm">
            <CheckCircle2 size={11} />
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              Done
            </span>
          </div>
        )}
        {c.course?.courseType === "FREE" && (
          <div className="absolute top-3 left-3 bg-brand-green-dark text-white rounded-full px-2.5 py-1 flex items-center gap-1 shadow-sm">
            <Gift size={10} />
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              Free
            </span>
          </div>
        )}
      </div>
      <div className="p-5">
        <h3 className="font-bold text-brand-navy leading-snug line-clamp-2 mb-3 group-hover:text-brand-mustard transition-colors">
          {c.course?.title}
        </h3>
        <div className="mb-4">
          <div className="flex justify-between text-xs text-brand-navy/60 mb-1.5">
            <span className="font-medium">Progress</span>
            <span className="font-semibold">{c.completionPercent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-brand-beige-dark overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-navy transition-all"
              style={{ width: `${c.completionPercent}%` }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Link
            to={`/student/course/${c.courseId}`}
            className="flex items-center gap-1.5 bg-brand-navy hover:bg-brand-navy-dark text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            <Play size={13} />{" "}
            {c.completionPercent > 0 ? "Continue" : "Start"}
          </Link>
          {c.isCompleted && (
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

// ── What's New card ──────────────────────────────────────────────────────────

function WhatsNewCard({
  icon: Icon,
  eyebrow,
  cta,
  to,
  tone,
}: {
  icon: React.ElementType;
  eyebrow: string;
  cta: string;
  to?: string;
  tone: "navy" | "green" | "mustard";
}) {
  const tones: Record<typeof tone, { bg: string; iconBg: string; iconColor: string }> = {
    navy: {
      bg: "bg-white border-brand-beige-dark hover:border-brand-navy/40",
      iconBg: "bg-brand-navy/10",
      iconColor: "text-brand-navy",
    },
    green: {
      bg: "bg-white border-brand-beige-dark hover:border-brand-green/50",
      iconBg: "bg-brand-green/10",
      iconColor: "text-brand-green-dark",
    },
    mustard: {
      bg: "bg-white border-brand-beige-dark hover:border-brand-mustard/50",
      iconBg: "bg-brand-mustard/15",
      iconColor: "text-brand-mustard",
    },
  };
  const t = tones[tone];

  const inner = (
    <>
      <div
        className={`w-10 h-10 rounded-lg ${t.iconBg} flex items-center justify-center mb-4`}
      >
        <Icon className={`${t.iconColor} w-5 h-5`} />
      </div>
      <p className="text-xs font-bold tracking-[0.14em] text-brand-navy/50 mb-1 uppercase">
        {eyebrow}
      </p>
      <p
        className={`text-sm font-semibold ${
          to ? "text-brand-navy" : "text-brand-navy/50"
        } flex items-center gap-1.5`}
      >
        {cta}
        {to && <ArrowRight size={13} className="text-brand-mustard" />}
      </p>
    </>
  );

  if (!to) {
    return (
      <div className={`rounded-2xl border p-5 ${t.bg} cursor-not-allowed`}>
        {inner}
      </div>
    );
  }

  return (
    <Link to={to} className={`rounded-2xl border p-5 ${t.bg} transition-colors block`}>
      {inner}
    </Link>
  );
}
