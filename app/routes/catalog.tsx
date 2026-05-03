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
  CheckCircle2,
  LogOut,
  UserCircle,
  MonitorPlay,
  Video,
  Key,
  Search,
} from "lucide-react";
import { Form, useNavigation } from "react-router";
import { useState } from "react";

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

  // If user is logged in, get their enrollments
  let enrolledCourseIds: Set<string> = new Set();
  if (user) {
    const [progresses, enrollments] = await Promise.all([
      prisma.progress.findMany({
        where: { userId: user.id },
        select: { courseId: true },
      }),
      prisma.enrollment.findMany({
        where: { userId: user.id },
        select: { courseId: true },
      }),
    ]);
    progresses.forEach((p) => enrolledCourseIds.add(p.courseId));
    enrollments.forEach((e) => enrolledCourseIds.add(e.courseId));
  }

  return {
    user,
    courses,
    q,
    categoryFilter,
    categories,
    totalPublished: allPublished.length,
    enrolledCourseIds: Array.from(enrolledCourseIds),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await getSessionUser(request);
  if (!user) return redirect("/auth/login?redirect=/catalog");

  const formData = await request.formData();
  const courseId = formData.get("courseId") as string;
  const intent = formData.get("intent") as string;

  if (intent === "enroll") {
    // Find the course and verify it's free + published
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

    // Create enrollment + progress record
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
  const { user, courses, q, categoryFilter, categories, totalPublished, enrolledCourseIds } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
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

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#2C795A] flex items-center justify-center shadow-lg shadow-green-900/30">
              <BookOpen className="text-white w-4 h-4" />
            </div>
            <span className="font-bold text-white text-lg hidden sm:block">
              InstructionalGraphics
            </span>
          </div>

          {/* Search */}
          <Form method="get" className="flex-1 max-w-md" onSubmit={() => {}}>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 inset-y-0 my-auto text-slate-500"
              />
              <input
                name="q"
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                type="text"
                placeholder="Search courses…"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#2C795A]"
              />
            </div>
          </Form>

          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <>
                <Link
                  to="/student"
                  className="text-slate-400 hover:text-white text-sm transition-colors flex items-center gap-1.5"
                >
                  <UserCircle size={16} /> My Courses
                </Link>
                <Form method="post" action="/auth/logout">
                  <button
                    type="submit"
                    className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors text-sm"
                  >
                    <LogOut size={16} /> Sign out
                  </button>
                </Form>
              </>
            ) : (
              <>
                <Link
                  to="/auth/login"
                  className="text-slate-400 hover:text-white text-sm transition-colors"
                >
                  Sign in
                </Link>
                <Link
                  to="/auth/register"
                  className="bg-[#2C795A] hover:bg-[#225A43] text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="bg-gradient-to-b from-slate-900 to-slate-950 border-b border-slate-800 py-16">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <h1 className="text-4xl font-bold text-white mb-3">
            Learn at Your Own Pace
          </h1>
          <p className="text-slate-400 text-lg max-w-xl mx-auto">
            Browse our library of professional courses. Free courses available
            instantly — paid courses require a license key.
          </p>
        </div>
      </div>

      {/* Category filter pills */}
      {categories.length > 0 && (
        <div className="bg-slate-950 border-b border-slate-800/60">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-2 overflow-x-auto scrollbar-none">
            <a
              href={categoryPillHref("")}
              className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap ${
                !categoryFilter
                  ? "bg-[#2C795A] border-[#2C795A] text-white"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500"
              }`}
            >
              All
              <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${!categoryFilter ? "bg-white/20 text-white" : "bg-slate-700 text-slate-400"}`}>
                {totalPublished}
              </span>
            </a>
            {categories.map(({ name, count }) => (
              <a
                key={name}
                href={categoryPillHref(name)}
                className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap ${
                  categoryFilter === name
                    ? "bg-[#2C795A] border-[#2C795A] text-white"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500"
                }`}
              >
                {name}
                <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${categoryFilter === name ? "bg-white/20 text-white" : "bg-slate-700 text-slate-400"}`}>
                  {count}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-12">
        {courses.length === 0 && (
          <div className="text-center py-20">
            <BookOpen className="mx-auto w-16 h-16 text-slate-700 mb-4" />
            <p className="text-slate-400 text-lg font-medium">
              No courses available yet.
            </p>
            <p className="text-slate-600 text-sm mt-1">
              {q ? `No results for "${q}". ` : ""}Check back soon!
            </p>
          </div>
        )}

        {/* Free courses */}
        {freeCourses.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-6">
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1">
                <Gift size={14} className="text-emerald-400" />
                <span className="text-emerald-400 text-sm font-semibold">
                  Free Courses
                </span>
              </div>
              <span className="text-slate-600 text-sm">
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

        {/* Paid courses */}
        {paidCourses.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-6">
              <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-full px-3 py-1">
                <DollarSign size={14} className="text-amber-400" />
                <span className="text-amber-400 text-sm font-semibold">
                  Paid Courses
                </span>
              </div>
              <span className="text-slate-600 text-sm">
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
      </main>
    </div>
  );
}

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
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-slate-600 transition-colors group flex flex-col">
      {/* Thumbnail */}
      <div
        className={`h-40 flex items-center justify-center relative overflow-hidden ${
          isStoryline
            ? "bg-gradient-to-br from-purple-900/30 to-slate-800"
            : "bg-gradient-to-br from-blue-900/30 to-slate-800"
        }`}
      >
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
          <MonitorPlay size={40} className="text-purple-700" />
        ) : (
          <Video size={40} className="text-blue-700" />
        )}

        {/* FREE / PAID badge */}
        <div
          className={`absolute top-3 left-3 flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
            isFree
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
          }`}
        >
          {isFree ? <Gift size={10} /> : <DollarSign size={10} />}
          {isFree ? "FREE" : `$${course.price?.toFixed(2)}`}
        </div>
      </div>

      {/* Body */}
      <div className="p-5 flex-1 flex flex-col">
        <h3 className="font-semibold text-white leading-snug line-clamp-2 mb-2 group-hover:text-[#C69445] transition-colors">
          {course.title}
        </h3>
        {course.description && (
          <p className="text-slate-500 text-xs line-clamp-2 mb-3">
            {course.description}
          </p>
        )}

        <div className="flex items-center gap-3 text-xs text-slate-600 mb-4">
          <span>{course._count.modules} modules</span>
          <span>·</span>
          <span>{course._count.progress} enrolled</span>
        </div>

        {/* CTA */}
        <div className="mt-auto">
          {isEnrolled ? (
            <Link
              to={`/student/course/${course.id}`}
              className="w-full flex items-center justify-center gap-2 bg-[#2C795A] hover:bg-[#225A43] text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
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
                  className="w-full flex items-center justify-center gap-2 bg-[#2C795A] hover:bg-[#225A43] text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                >
                  <Gift size={14} /> Enroll for Free
                </button>
              </fetcher.Form>
            ) : (
              <Link
                to="/auth/login?redirect=/catalog"
                className="w-full flex items-center justify-center gap-2 bg-[#2C795A] hover:bg-[#225A43] text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
              >
                Sign in to Enroll
              </Link>
            )
          ) : (
            <Link
              to="/redeem"
              className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-white text-sm font-medium px-4 py-2.5 rounded-lg border border-white/10 hover:border-white/20 transition-colors"
            >
              <Key size={14} /> Redeem License Key
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
