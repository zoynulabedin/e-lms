import { Link, redirect, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireUser } from "../utils/auth.server";
import { prisma } from "../utils/db.server";
import { getAccessibleCourseIds } from "../utils/access.server";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";
import {
  FolderOpen,
  Download,
  FileText,
  ExternalLink,
  Youtube,
  Globe,
  Key,
  LifeBuoy,
  BookOpen,
} from "lucide-react";

const YOUTUBE_URL = "https://www.youtube.com/@TeachMeLikeATot";
const WEBSITE_URL = "https://www.teachmelikeatot.org";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (user.role === "ADMIN") return redirect("/");

  // Only courses the user is actually entitled to (ACTIVE license, or an
  // enrolment on a FREE course) — never derived from Progress rows.
  const [courseIds, progresses] = await Promise.all([
    getAccessibleCourseIds(user.id),
    prisma.progress.findMany({
      where: { userId: user.id, completedAt: { not: null } },
      select: { courseId: true, completedAt: true },
    }),
  ]);

  const courses = courseIds.length
    ? await prisma.course.findMany({
        where: { id: { in: courseIds } },
        select: {
          id: true,
          title: true,
          thumbnailUrl: true,
          modules: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              title: true,
              lessons: {
                where: { lessonType: "DOWNLOAD" },
                orderBy: { order: "asc" },
                select: {
                  id: true,
                  title: true,
                  resourceUrl: true,
                },
              },
            },
          },
        },
        orderBy: { title: "asc" },
      })
    : [];

  // Flatten to course → downloads, dropping courses with nothing to download.
  const courseResources = courses
    .map((course) => ({
      id: course.id,
      title: course.title,
      thumbnailUrl: course.thumbnailUrl,
      downloads: course.modules.flatMap((m) =>
        m.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          resourceUrl: l.resourceUrl,
          moduleTitle: m.title,
        })),
      ),
    }))
    .filter((c) => c.downloads.length > 0);

  const totalDownloads = courseResources.reduce(
    (n, c) => n + c.downloads.length,
    0,
  );

  const hasCertificates = progresses.length > 0;

  return { user, courseResources, totalDownloads, hasCertificates };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Best-effort file type label from the URL extension (e.g. "PDF", "ZIP"). */
function fileTypeLabel(url: string | null): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url, "https://x").pathname;
    const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
    if (!ext || ext.length > 5 || pathname.endsWith("/")) return null;
    return ext.toUpperCase();
  } catch {
    return null;
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StudentResources() {
  const { user, courseResources, totalDownloads, hasCertificates } =
    useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar
          user={user}
          active="resources"
          certificatesEnabled={hasCertificates}
        />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar />
          <StudentTopbar user={user} />

          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
            {/* Hero */}
            <div className="mb-10">
              <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
                <FolderOpen size={14} />
                Resources
              </div>
              <h1 className="font-display text-4xl sm:text-5xl text-brand-navy">
                Course materials &amp; downloads
              </h1>
              <p className="text-brand-navy/60 mt-2 max-w-2xl">
                Every worksheet, guide, and file from your courses in one place
                — plus a few helpful links to keep learning.
              </p>
            </div>

            {/* Downloads */}
            <section className="mb-12">
              <div className="flex items-center justify-between gap-4 mb-5">
                <div className="flex items-center gap-2">
                  <Download className="text-brand-navy" size={22} />
                  <h2 className="font-display text-2xl text-brand-navy">
                    Downloads from your courses
                  </h2>
                </div>
                {totalDownloads > 0 && (
                  <span className="text-xs font-semibold text-brand-navy/60 bg-white border border-brand-beige-dark rounded-full px-3 py-1">
                    {totalDownloads} file{totalDownloads === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {courseResources.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-brand-beige-dark bg-white p-10 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-brand-mustard/15 flex items-center justify-center mx-auto mb-4">
                    <FileText className="text-brand-mustard" size={26} />
                  </div>
                  <p className="text-brand-navy font-medium">
                    No downloadable materials yet
                  </p>
                  <p className="text-brand-navy/60 text-sm mt-1 max-w-md mx-auto">
                    When a course you're enrolled in includes worksheets or
                    files, they'll show up here.
                  </p>
                  <Link
                    to="/student"
                    className="inline-flex items-center gap-1.5 mt-5 text-sm font-semibold text-brand-navy hover:text-brand-green transition-colors"
                  >
                    <BookOpen size={16} />
                    Go to my courses
                  </Link>
                </div>
              ) : (
                <div className="space-y-6">
                  {courseResources.map((course) => (
                    <CourseResourceGroup key={course.id} course={course} />
                  ))}
                </div>
              )}
            </section>

            {/* Helpful links */}
            <section className="mb-4">
              <h2 className="font-display text-2xl text-brand-navy mb-5">
                Helpful links
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <ResourceLink
                  href={YOUTUBE_URL}
                  external
                  icon={Youtube}
                  title="Watch & Learn"
                  subtitle="Free videos on YouTube"
                />
                <ResourceLink
                  href={WEBSITE_URL}
                  external
                  icon={Globe}
                  title="Teach Me Like a Tot"
                  subtitle="Visit the main website"
                />
                <ResourceLink
                  href="/redeem"
                  icon={Key}
                  title="Redeem Key"
                  subtitle="Unlock a purchased course"
                />
                <ResourceLink
                  href="/student/help"
                  icon={LifeBuoy}
                  title="Help & Support"
                  subtitle="FAQs and contact"
                />
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Course group ─────────────────────────────────────────────────────────────

function CourseResourceGroup({
  course,
}: {
  course: {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    downloads: Array<{
      id: string;
      title: string;
      resourceUrl: string | null;
      moduleTitle: string;
    }>;
  };
}) {
  return (
    <div className="rounded-2xl border border-brand-beige-dark bg-white overflow-hidden">
      {/* Course header */}
      <div className="flex items-center gap-4 px-5 sm:px-6 py-4 border-b border-brand-beige-dark bg-brand-beige/40">
        {course.thumbnailUrl ? (
          <img
            src={course.thumbnailUrl}
            alt=""
            className="w-12 h-12 rounded-lg object-cover shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-brand-navy/10 flex items-center justify-center shrink-0">
            <BookOpen className="text-brand-navy" size={20} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-display text-lg text-brand-navy leading-tight truncate">
            {course.title}
          </p>
          <p className="text-brand-navy/60 text-xs mt-0.5">
            {course.downloads.length} file
            {course.downloads.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          to={`/student/course/${course.id}`}
          className="hidden sm:inline-flex items-center gap-1 text-xs font-semibold text-brand-navy/70 hover:text-brand-navy transition-colors shrink-0"
        >
          Open course
          <ExternalLink size={12} />
        </Link>
      </div>

      {/* Files */}
      <ul className="divide-y divide-brand-beige-dark">
        {course.downloads.map((file) => {
          const type = fileTypeLabel(file.resourceUrl);
          return (
            <li
              key={file.id}
              className="flex items-center gap-4 px-5 sm:px-6 py-4"
            >
              <div className="w-10 h-10 rounded-lg bg-brand-mustard/15 flex items-center justify-center shrink-0">
                <FileText className="text-brand-mustard" size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-brand-navy font-semibold text-sm sm:text-base truncate">
                  {file.title}
                </p>
                <p className="text-brand-navy/55 text-xs mt-0.5 truncate">
                  {file.moduleTitle}
                  {type && (
                    <>
                      {" · "}
                      <span className="font-semibold tracking-wide">
                        {type}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  to={`/student/course/${course.id}?lesson=${file.id}`}
                  className="hidden md:inline-flex items-center px-3 py-2 rounded-lg text-xs font-semibold text-brand-navy/70 hover:bg-brand-beige transition-colors"
                >
                  View in course
                </Link>
                {file.resourceUrl ? (
                  <a
                    href={file.resourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-brand-navy hover:bg-brand-navy-dark text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors"
                  >
                    <Download size={14} />
                    Download
                  </a>
                ) : (
                  <span
                    className="inline-flex items-center gap-1.5 bg-brand-beige text-brand-navy/40 text-xs font-semibold px-3.5 py-2 rounded-lg cursor-not-allowed"
                    title="No download URL configured"
                  >
                    <Download size={14} />
                    Unavailable
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Helpful link card ────────────────────────────────────────────────────────

function ResourceLink({
  href,
  external = false,
  icon: Icon,
  title,
  subtitle,
}: {
  href: string;
  external?: boolean;
  icon: React.ElementType;
  title: string;
  subtitle: string;
}) {
  const className =
    "block rounded-2xl border border-brand-beige-dark bg-white p-5 hover:border-brand-navy/30 hover:shadow-sm transition-all";
  const body = (
    <>
      <div className="w-10 h-10 rounded-lg bg-brand-navy/10 flex items-center justify-center mb-3">
        <Icon className="text-brand-navy w-5 h-5" />
      </div>
      <p className="font-display text-lg text-brand-navy leading-tight">
        {title}
      </p>
      <p className="text-brand-navy/60 text-sm mt-0.5">{subtitle}</p>
    </>
  );

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {body}
    </Link>
  );
}
