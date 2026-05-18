import { redirect, data } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { getSessionUser } from "../utils/auth.server";
import {
  BookOpen,
  Gift,
  DollarSign,
  Play,
  MonitorPlay,
  Video,
  Key,
  Search,
} from "lucide-react";
import { Form } from "react-router";
import { useState } from "react";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const categoryFilter = url.searchParams.get("category") || "";

  // Redirect admin to admin dashboard
  if (user?.role === "ADMIN") return redirect("/");

  const searchWhere = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" as const } },
          { description: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  // Fetch all published courses for category counts + filtered list in parallel
  const [allPublished, courses] = await Promise.all([
    prisma.course.findMany({
      where: { status: "PUBLISHED" },
      select: { category: true },
    }),
    prisma.course.findMany({
      where: {
        status: "PUBLISHED",
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...searchWhere,
      },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { progress: true, modules: true } },
      },
    }),
  ]);

  // Build category list with counts
  const categoryMap = new Map<string, number>();
  for (const c of allPublished) {
    if (c.category) {
      categoryMap.set(c.category, (categoryMap.get(c.category) ?? 0) + 1);
    }
  }
  const categories = Array.from(categoryMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // If user is logged in, get their enrollments + certificates count
  let enrolledCourseIds: Set<string> = new Set();
  let hasCertificates = false;
  if (user) {
    const [progresses, enrollments, completedCount] = await Promise.all([
      prisma.progress.findMany({
        where: { userId: user.id },
        select: { courseId: true },
      }),
      prisma.enrollment.findMany({
        where: { userId: user.id },
        select: { courseId: true },
      }),
      prisma.progress.count({
        where: { userId: user.id, isCompleted: true },
      }),
    ]);
    progresses.forEach((p) => enrolledCourseIds.add(p.courseId));
    enrollments.forEach((e) => enrolledCourseIds.add(e.courseId));
    hasCertificates = completedCount > 0;
  }

  return {
    user,
    courses,
    q,
    categoryFilter,
    categories,
    totalPublished: allPublished.length,
    enrolledCourseIds: Array.from(enrolledCourseIds),
    hasCertificates,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/auth/login?redirect=/catalog");

  const formData = await request.formData();
  const courseId = formData.get("courseId") as string;
  const intent = formData.get("intent") as string;

  if (intent === "enroll") {
    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course || course.status !== "PUBLISHED") {
      return data({ error: "Course not found." }, { status: 404 });
    }
    if (course.courseType !== "FREE") {
      return data(
        { error: "This course requires a license key." },
        { status: 403 },
      );
    }

    await prisma.enrollment.upsert({
      where: { userId_courseId: { userId: user.id, courseId } },
      update: {},
      create: { userId: user.id, courseId },
    });

    await prisma.progress.upsert({
      where: { userId_courseId: { userId: user.id, courseId } },
      update: {},
      create: { userId: user.id, courseId },
    });

    return redirect(`/student/course/${courseId}`);
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Catalog() {
  const {
    user,
    courses,
    q,
    categoryFilter,
    categories,
    totalPublished,
    enrolledCourseIds,
    hasCertificates,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const enrolledSet = new Set(enrolledCourseIds);
  const [searchVal, setSearchVal] = useState(q);

  const freeCourses = courses.filter((c) => c.courseType === "FREE");
  const paidCourses = courses.filter((c) => c.courseType === "PAID");

  const categoryPillHref = (cat: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat) params.set("category", cat);
    return `/catalog${params.toString() ? `?${params.toString()}` : ""}`;
  };

  const content = (
    <>
      {/* Hero */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
          <BookOpen size={14} />
          Browse Courses
        </div>
        <h1 className="font-display text-4xl sm:text-5xl text-brand-navy">
          Learn at Your Own Pace
        </h1>
        <p className="text-brand-navy/60 mt-2 max-w-2xl">
          Browse our library of professional courses. Free courses available
          instantly — paid courses require a license key.
        </p>
      </div>

      {/* Search */}
      <Form method="get" className="mb-6">
        <div className="relative max-w-md">
          <Search
            size={16}
            className="absolute left-3 inset-y-0 my-auto text-brand-navy/40"
          />
          <input
            name="q"
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            type="text"
            placeholder="Search courses…"
            className="w-full bg-white border border-brand-beige-dark rounded-xl pl-10 pr-3 py-2.5 text-sm text-brand-navy placeholder-brand-navy/40 focus:outline-none focus:border-brand-navy"
          />
        </div>
      </Form>

      {/* Category filter pills */}
      {categories.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none mb-8 -mx-1 px-1">
          <CategoryPill
            href={categoryPillHref("")}
            label="All"
            count={totalPublished}
            active={!categoryFilter}
          />
          {categories.map(({ name, count }) => (
            <CategoryPill
              key={name}
              href={categoryPillHref(name)}
              label={name}
              count={count}
              active={categoryFilter === name}
            />
          ))}
        </div>
      )}

      {/* Course sections */}
      <div className="space-y-12">
        {courses.length === 0 && (
          <div className="text-center py-20 border-2 border-dashed border-brand-beige-dark rounded-2xl bg-white">
            <BookOpen className="mx-auto w-14 h-14 text-brand-navy/30 mb-3" />
            <p className="text-brand-navy font-medium">
              No courses available yet.
            </p>
            <p className="text-brand-navy/55 text-sm mt-1">
              {q ? `No results for "${q}". ` : ""}Check back soon!
            </p>
          </div>
        )}

        {freeCourses.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex items-center gap-2 bg-brand-green/10 border border-brand-green/30 rounded-full px-3 py-1">
                <Gift size={14} className="text-brand-green-dark" />
                <span className="text-brand-green-dark text-xs font-bold uppercase tracking-wider">
                  Free Courses
                </span>
              </div>
              <span className="text-brand-navy/50 text-sm">
                {freeCourses.length} available
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {freeCourses.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  isEnrolled={enrolledSet.has(course.id)}
                  user={user}
                  fetcher={fetcher}
                />
              ))}
            </div>
          </section>
        )}

        {paidCourses.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-5">
              <div className="flex items-center gap-2 bg-brand-mustard/15 border border-brand-mustard/40 rounded-full px-3 py-1">
                <DollarSign size={14} className="text-brand-mustard" />
                <span className="text-brand-mustard text-xs font-bold uppercase tracking-wider">
                  Paid Courses
                </span>
              </div>
              <span className="text-brand-navy/50 text-sm">
                {paidCourses.length} available
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {paidCourses.map((course) => (
                <CourseCard
                  key={course.id}
                  course={course}
                  isEnrolled={enrolledSet.has(course.id)}
                  user={user}
                  fetcher={fetcher}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );

  // ── Logged-in: sidebar layout (matches student dashboard) ──────────────────
  if (user) {
    return (
      <div className="min-h-screen bg-brand-beige">
        <Toast />
        <div className="flex">
          <StudentSidebar
            user={user}
            active="browse"
            certificatesEnabled={hasCertificates}
          />
          <main className="flex-1 min-w-0">
            <StudentMobileTopbar />
            <StudentTopbar user={user} />
            <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
              {content}
            </div>
          </main>
        </div>
      </div>
    );
  }

  // ── Guest: simple header + same content ────────────────────────────────────
  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />
      {/* Guest header */}
      <header className="bg-brand-navy-deeper border-b border-white/10 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between gap-4">
          <Link to="/catalog" className="flex items-center">
            <img
              src="/White_center.avif"
              alt="Teach Me Like a Tot"
              className="h-10 w-auto object-contain"
            />
          </Link>
          <div className="flex items-center gap-3 shrink-0">
            <Link
              to="/auth/login"
              className="text-white/80 hover:text-white text-sm font-medium transition-colors"
            >
              Sign in
            </Link>
            <Link
              to="/auth/register"
              className="bg-brand-mustard hover:bg-brand-mustard/90 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              Sign up
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
        {content}
      </main>
    </div>
  );
}

// ── Category pill ─────────────────────────────────────────────────────────────

function CategoryPill({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <a
      href={href}
      className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap ${
        active
          ? "bg-brand-navy border-brand-navy text-white"
          : "bg-white border-brand-beige-dark text-brand-navy/70 hover:text-brand-navy hover:border-brand-navy/40"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${
          active
            ? "bg-white/25 text-white"
            : "bg-brand-beige text-brand-navy/60"
        }`}
      >
        {count}
      </span>
    </a>
  );
}

// ── Course card ───────────────────────────────────────────────────────────────

function CourseCard({
  course,
  isEnrolled,
  user,
  fetcher,
}: {
  course: any;
  isEnrolled: boolean;
  user: any;
  fetcher: any;
}) {
  const isFree = course.courseType === "FREE";
  const isStoryline = course.contentType === "STORYLINE";

  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark overflow-hidden hover:border-brand-navy/30 transition-colors group flex flex-col">
      {/* Thumbnail */}
      <div className="h-40 bg-brand-beige-dark flex items-center justify-center relative overflow-hidden">
        {course.thumbnailUrl ? (
          <img
            src={course.thumbnailUrl}
            alt={course.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : isStoryline ? (
          <MonitorPlay size={40} className="text-brand-navy/30" />
        ) : (
          <Video size={40} className="text-brand-navy/30" />
        )}

        {/* FREE / PAID badge */}
        <div
          className={`absolute top-3 left-3 flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm ${
            isFree
              ? "bg-brand-green-dark text-white"
              : "bg-brand-mustard text-white"
          }`}
        >
          {isFree ? <Gift size={10} /> : <DollarSign size={10} />}
          {isFree ? "FREE" : `$${course.price?.toFixed(2) ?? "0.00"}`}
        </div>
      </div>

      {/* Body */}
      <div className="p-5 flex-1 flex flex-col">
        <h3 className="font-display text-lg text-brand-navy leading-snug line-clamp-2 mb-2 group-hover:text-brand-mustard transition-colors">
          {course.title}
        </h3>
        {course.description && (
          <p className="text-brand-navy/55 text-xs line-clamp-2 mb-3">
            {course.description}
          </p>
        )}

        <div className="flex items-center gap-3 text-xs text-brand-navy/50 mb-4">
          <span>{course._count.modules} modules</span>
          <span>·</span>
          <span>{course._count.progress} enrolled</span>
        </div>

        {/* CTA */}
        <div className="mt-auto">
          {isEnrolled ? (
            <Link
              to={`/student/course/${course.id}`}
              className="w-full flex items-center justify-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              <Play size={14} /> Continue Learning
            </Link>
          ) : isFree ? (
            user ? (
              <fetcher.Form method="post">
                <input type="hidden" name="courseId" value={course.id} />
                <input type="hidden" name="intent" value="enroll" />
                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 bg-brand-green-dark hover:bg-brand-green text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                >
                  <Gift size={14} /> Enroll for Free
                </button>
              </fetcher.Form>
            ) : (
              <Link
                to="/auth/login?redirect=/catalog"
                className="w-full flex items-center justify-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
              >
                Sign in to Enroll
              </Link>
            )
          ) : (
            <Link
              to="/redeem"
              className="w-full flex items-center justify-center gap-2 bg-brand-mustard hover:bg-brand-mustard/90 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              <Key size={14} /> Redeem License Key
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
