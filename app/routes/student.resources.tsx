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
              order: true,
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

  // Resources the admin attached to the course itself. Scoped to the courses
  // this learner holds a licence for — another course's files are never even
  // fetched, let alone rendered. Tolerates a server that has not migrated yet.
  const extras = courseIds.length
    ? await prisma.courseResource
        .findMany({
          where: { courseId: { in: courseIds }, isActive: true },
          orderBy: [{ order: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            courseId: true,
            title: true,
            description: true,
            kind: true,
            fileName: true,
            fileType: true,
            fileSize: true,
            // The module the lesson sits in, so the table can say which part
            // of the course a handout belongs to.
            lesson: {
              select: {
                id: true,
                title: true,
                module: { select: { id: true, title: true, order: true } },
              },
            },
          },
        })
        .catch((err: unknown) => {
          console.error("[resources] CourseResource unavailable:", err);
          return [] as never[];
        })
    : [];

  /**
   * Course -> module -> the handouts that belong to it.
   *
   * Grouping by module is the point: a worksheet only means something next to
   * the part of the course it came from. Anything attached to the course
   * rather than to a lesson lands in a final "Whole course" group.
   *
   * Every href points at /student/resource/<id>, which re-checks the licence
   * on each request - the storage URL is never serialized into the page.
   */
  type Row = {
    id: string;
    title: string;
    kind: string;
    href: string | null;
    lessonTitle: string | null;
    description: string | null;
    typeLabel: string | null;
    fileSize: number | null;
    lessonId: string | null;
  };

  const courseResources = courses
    .map((course) => {
      // Keyed by module id; the null key collects course-wide resources.
      const groups = new Map<string | null, { title: string; order: number; items: Row[] }>();

      const push = (
        moduleId: string | null,
        moduleTitle: string,
        order: number,
        row: Row,
      ) => {
        const key = moduleId;
        if (!groups.has(key)) groups.set(key, { title: moduleTitle, order, items: [] });
        groups.get(key)!.items.push(row);
      };

      for (const r of extras.filter((x) => x.courseId === course.id)) {
        push(
          r.lesson?.module?.id ?? null,
          r.lesson?.module?.title ?? "Whole course",
          // Course-wide resources sort last, after every real module.
          r.lesson?.module?.order ?? Number.MAX_SAFE_INTEGER,
          {
            id: r.id,
            title: r.title,
            kind: r.kind,
            href: `/student/resource/${r.id}`,
            lessonTitle: r.lesson?.title ?? null,
            description: r.description,
            typeLabel: fileTypeLabel(r.fileName) ?? r.fileType ?? null,
            fileSize: r.fileSize,
            lessonId: r.lesson?.id ?? null,
          },
        );
      }

      for (const m of course.modules) {
        for (const l of m.lessons) {
          push(m.id, m.title, m.order, {
            id: l.id,
            title: l.title,
            kind: "FILE",
            href: l.resourceUrl ? `/student/resource/${l.id}` : null,
            lessonTitle: l.title,
            description: null,
            // Derived here, so the Cloudinary URL never reaches the page.
            typeLabel: fileTypeLabel(l.resourceUrl),
            fileSize: null,
            lessonId: l.id,
          });
        }
      }

      const modules = [...groups.entries()]
        .map(([moduleId, g]) => ({
          moduleId,
          moduleTitle: g.title,
          order: g.order,
          items: g.items,
        }))
        .sort((a, b) => a.order - b.order);

      return {
        id: course.id,
        title: course.title,
        thumbnailUrl: course.thumbnailUrl,
        modules,
        total: modules.reduce((n, m) => n + m.items.length, 0),
      };
    })
    .filter((c) => c.total > 0);

  const totalDownloads = courseResources.reduce((n, c) => n + c.total, 0);

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

/** Human-readable size, or null when the admin never recorded one. */
function fileSizeLabel(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar active="resources" certificatesEnabled={hasCertificates} />
          <StudentTopbar user={user} certificatesEnabled={hasCertificates} />

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
    total: number;
    modules: Array<{
      moduleId: string | null;
      moduleTitle: string;
      items: Array<{
        id: string;
        title: string;
        kind: string;
        /** Always /student/resource/<id> — never a raw storage URL. */
        href: string | null;
        lessonTitle: string | null;
        description: string | null;
        /** e.g. "PDF" — resolved server-side; the storage URL never ships. */
        typeLabel: string | null;
        fileSize: number | null;
        lessonId: string | null;
      }>;
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
            {course.total} file{course.total === 1 ? "" : "s"} across{" "}
            {course.modules.length} section{course.modules.length === 1 ? "" : "s"}
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

      {/* One table per module, in course order, with course-wide files last. */}
      {course.modules.map((m) => (
        <section key={m.moduleId ?? "course-wide"}>
          <h3 className="flex items-center gap-2 px-5 sm:px-6 py-2.5 bg-brand-beige/60 border-y border-brand-beige-dark text-brand-navy font-semibold text-sm">
            {m.moduleId ? (
              <BookOpen size={14} className="text-brand-navy/60 shrink-0" />
            ) : (
              <FolderOpen size={14} className="text-brand-navy/60 shrink-0" />
            )}
            <span className="min-w-0 truncate">{m.moduleTitle}</span>
            <span className="text-brand-navy/50 font-normal text-xs shrink-0">
              ({m.items.length})
            </span>
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Downloads in {m.moduleTitle} of {course.title}
              </caption>
              <thead>
                <tr className="text-left border-b border-brand-beige-dark">
                  <th scope="col" className="px-5 sm:px-6 py-2 font-semibold text-brand-navy/60 text-[11px] uppercase tracking-wider">
                    Resource
                  </th>
                  <th scope="col" className="hidden md:table-cell px-4 py-2 font-semibold text-brand-navy/60 text-[11px] uppercase tracking-wider">
                    Lesson
                  </th>
                  <th scope="col" className="hidden sm:table-cell px-4 py-2 font-semibold text-brand-navy/60 text-[11px] uppercase tracking-wider">
                    Type
                  </th>
                  <th scope="col" className="px-5 sm:px-6 py-2 text-right">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-beige-dark">
                {m.items.map((file) => {
                  const size = fileSizeLabel(file.fileSize);
                  const isLink = file.kind === "LINK";
                  return (
                    <tr key={file.id} className="align-middle hover:bg-brand-beige/20 transition-colors">
                      <td className="px-5 sm:px-6 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-9 h-9 rounded-lg bg-brand-mustard/15 flex items-center justify-center shrink-0">
                            {isLink ? (
                              <ExternalLink className="text-brand-mustard" size={16} />
                            ) : (
                              <FileText className="text-brand-mustard" size={16} />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-brand-navy font-semibold truncate">
                              {file.title}
                            </span>
                            {file.description && (
                              <span className="block text-brand-navy/55 text-xs truncate">
                                {file.description}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>

                      <td className="hidden md:table-cell px-4 py-3 text-brand-navy/60">
                        {file.lessonTitle ?? "\u2014"}
                      </td>

                      <td className="hidden sm:table-cell px-4 py-3 text-brand-navy/60 whitespace-nowrap">
                        {isLink ? "Link" : (file.typeLabel ?? "File")}
                        {size && <span className="text-brand-navy/40"> &middot; {size}</span>}
                      </td>

                      <td className="px-5 sm:px-6 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          {file.lessonId && (
                            <Link
                              to={`/student/course/${course.id}?lesson=${file.lessonId}`}
                              className="hidden lg:inline-flex items-center px-3 py-2 rounded-lg text-xs font-semibold text-brand-navy/70 hover:bg-brand-beige transition-colors"
                            >
                              View in course
                            </Link>
                          )}
                          {file.href ? (
                            <a
                              href={file.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 bg-brand-navy hover:bg-brand-navy-dark text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors"
                            >
                              {isLink ? <ExternalLink size={14} /> : <Download size={14} />}
                              {isLink ? "Open" : "Download"}
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
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
