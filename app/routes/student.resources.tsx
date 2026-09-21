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
  BookMarked,
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
                  order: true,
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
            // The video the handout hangs off, and the module that video sits
            // in - both are columns in the table.
            lesson: {
              select: {
                id: true,
                title: true,
                order: true,
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

  // The glossary the course player shows behind its GLOSSARY link. Same
  // entitlement rule as the handouts: only courses this learner holds a
  // licence for are ever queried. Tolerates a server that has not migrated.
  const terms = courseIds.length
    ? await prisma.glossaryTerm
        .findMany({
          where: { courseId: { in: courseIds } },
          orderBy: [{ term: "asc" }],
          select: { id: true, courseId: true, term: true, definition: true },
        })
        .catch((err: unknown) => {
          console.error("[resources] GlossaryTerm unavailable:", err);
          return [] as never[];
        })
    : [];

  /**
   * Course -> one flat list of handouts, ordered the way the course reads:
   * module order, then the video's order inside it, then the order the admin
   * gave the resources. Module and video are columns, so a learner can see at
   * a glance which part of the course a file came from.
   *
   * Anything attached to the course rather than to a video has no module or
   * video and sorts last.
   *
   * Every href points at /student/resource/<id>, which re-checks the licence
   * on each request - the storage URL is never serialized into the page.
   */
  const LAST = Number.MAX_SAFE_INTEGER;

  const courseResources = courses
    .map((course) => {
      const rows = [
        ...extras
          .filter((r) => r.courseId === course.id)
          .map((r) => ({
            id: r.id,
            title: r.title,
            kind: r.kind,
            href: `/student/resource/${r.id}`,
            moduleTitle: r.lesson?.module?.title ?? null,
            videoTitle: r.lesson?.title ?? null,
            description: r.description,
            typeLabel: fileTypeLabel(r.fileName) ?? r.fileType ?? null,
            fileSize: r.fileSize,
            lessonId: r.lesson?.id ?? null,
            _m: r.lesson?.module?.order ?? LAST,
            _l: r.lesson?.order ?? LAST,
          })),
        // DOWNLOAD lessons are themselves the handout, so the video and the
        // resource are the same row.
        ...course.modules.flatMap((m) =>
          m.lessons.map((l) => ({
            id: l.id,
            title: l.title,
            kind: "FILE",
            href: l.resourceUrl ? `/student/resource/${l.id}` : null,
            moduleTitle: m.title,
            videoTitle: l.title,
            description: null as string | null,
            // Derived here, so the Cloudinary URL never reaches the page.
            typeLabel: fileTypeLabel(l.resourceUrl),
            fileSize: null as number | null,
            lessonId: l.id as string | null,
            _m: m.order,
            _l: l.order,
          })),
        ),
      ].sort((a, b) => a._m - b._m || a._l - b._l);

      const glossary = terms
        .filter((t) => t.courseId === course.id)
        .map(({ id, term, definition }) => ({ id, term, definition }));

      return {
        id: course.id,
        title: course.title,
        thumbnailUrl: course.thumbnailUrl,
        rows: rows.map(({ _m, _l, ...r }) => r),
        total: rows.length,
        glossary,
      };
    })
    // A course earns a card if it has handouts OR glossary terms - this page
    // covers both of the course player's header links, not just one.
    .filter((c) => c.total > 0 || c.glossary.length > 0);

  const totalDownloads = courseResources.reduce((n, c) => n + c.total, 0);
  const totalTerms = courseResources.reduce((n, c) => n + c.glossary.length, 0);

  const hasCertificates = progresses.length > 0;

  return { user, courseResources, totalDownloads, totalTerms, hasCertificates };
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
  const { user, courseResources, totalDownloads, totalTerms, hasCertificates } =
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
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-5">
                <div className="flex items-center gap-2">
                  <Download className="text-brand-navy" size={22} />
                  <h2 className="font-display text-2xl text-brand-navy">
                    Handouts &amp; glossary
                  </h2>
                </div>
                {totalTerms > 0 && (
                  <span className="text-xs font-semibold text-brand-navy/60 bg-white border border-brand-beige-dark rounded-full px-3 py-1">
                    {totalTerms} term{totalTerms === 1 ? "" : "s"}
                  </span>
                )}
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
                    No course materials yet
                  </p>
                  <p className="text-brand-navy/60 text-sm mt-1 max-w-md mx-auto">
                    When a course you own includes worksheets, handouts or a
                    glossary, they'll show up here.
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
    rows: Array<{
      id: string;
      title: string;
      kind: string;
      /** Always /student/resource/<id> — never a raw storage URL. */
      href: string | null;
      /** null for a handout attached to the course rather than to a video. */
      moduleTitle: string | null;
      videoTitle: string | null;
      description: string | null;
      /** e.g. "PDF" — resolved server-side; the storage URL never ships. */
      typeLabel: string | null;
      fileSize: number | null;
      lessonId: string | null;
    }>;
    glossary: Array<{ id: string; term: string; definition: string }>;
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
            {course.total} file{course.total === 1 ? "" : "s"}
            {course.glossary.length > 0 && (
              <> &middot; {course.glossary.length} glossary term
                {course.glossary.length === 1 ? "" : "s"}</>
            )}
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

      {/* One table for the course. Module and video are columns so a learner
          can see which part of the course each file came from; rows are in
          course order. Repeated module/video names are dimmed rather than
          blanked, so a row still reads on its own when sorted or scanned. */}
      {course.total > 0 && (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Downloads for {course.title}, with the module and video each one belongs to
          </caption>
          <thead>
            <tr className="text-left border-b border-brand-beige-dark bg-brand-beige/30">
              <th scope="col" className="px-5 sm:px-6 py-2.5 font-semibold text-brand-navy/70 text-[11px] uppercase tracking-wider">
                Module
              </th>
              <th scope="col" className="hidden sm:table-cell px-4 py-2.5 font-semibold text-brand-navy/70 text-[11px] uppercase tracking-wider">
                Video
              </th>
              <th scope="col" className="px-4 py-2.5 font-semibold text-brand-navy/70 text-[11px] uppercase tracking-wider">
                Resource
              </th>
              <th scope="col" className="px-5 sm:px-6 py-2.5 text-right">
                <span className="sr-only">Download</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-beige-dark">
            {course.rows.map((file, i) => {
              const size = fileSizeLabel(file.fileSize);
              const isLink = file.kind === "LINK";
              const prev = course.rows[i - 1];
              const sameModule = prev && prev.moduleTitle === file.moduleTitle;
              const sameVideo = sameModule && prev.videoTitle === file.videoTitle;
              return (
                <tr key={file.id} className="align-top hover:bg-brand-beige/20 transition-colors">
                  <td className={`px-5 sm:px-6 py-3 ${sameModule ? "text-brand-navy/35" : "text-brand-navy/85 font-medium"}`}>
                    {file.moduleTitle ?? (
                      <span className="italic text-brand-navy/45">Whole course</span>
                    )}
                  </td>

                  <td className={`hidden sm:table-cell px-4 py-3 ${sameVideo ? "text-brand-navy/35" : "text-brand-navy/70"}`}>
                    {file.videoTitle ?? "\u2014"}
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-brand-mustard/15 flex items-center justify-center shrink-0 mt-0.5">
                        {isLink ? (
                          <ExternalLink className="text-brand-mustard" size={15} />
                        ) : (
                          <FileText className="text-brand-mustard" size={15} />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-brand-navy font-semibold">{file.title}</span>
                        <span className="block text-brand-navy/50 text-xs">
                          {isLink ? "Link" : (file.typeLabel ?? "File")}
                          {size && <> &middot; {size}</>}
                        </span>
                        {file.description && (
                          <span className="block text-brand-navy/55 text-xs mt-0.5">
                            {file.description}
                          </span>
                        )}
                        {/* The video name again, for the phone layout where the
                            Video column is hidden. */}
                        {file.videoTitle && (
                          <span className="sm:hidden block text-brand-navy/45 text-xs mt-0.5">
                            {file.videoTitle}
                          </span>
                        )}
                      </span>
                    </div>
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
      )}

      {/* Glossary — the other half of what the course player's header offers,
          so a learner does not have to open a lesson to read the terms. */}
      {course.glossary.length > 0 && (
        <div>
          <h3 className="flex items-center gap-2 px-5 sm:px-6 py-2.5 bg-brand-beige/60 border-y border-brand-beige-dark text-brand-navy font-semibold text-sm">
            <BookMarked size={14} className="text-brand-navy/60 shrink-0" />
            Glossary
            <span className="text-brand-navy/50 font-normal text-xs">
              ({course.glossary.length})
            </span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Glossary for {course.title}</caption>
              <thead>
                <tr className="text-left border-b border-brand-beige-dark">
                  <th scope="col" className="px-5 sm:px-6 py-2 font-semibold text-brand-navy/70 text-[11px] uppercase tracking-wider w-1/3">
                    Term
                  </th>
                  <th scope="col" className="px-4 sm:px-6 py-2 font-semibold text-brand-navy/70 text-[11px] uppercase tracking-wider">
                    Meaning
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-beige-dark">
                {course.glossary.map((t) => (
                  <tr key={t.id} className="align-top hover:bg-brand-beige/20 transition-colors">
                    <th scope="row" className="px-5 sm:px-6 py-3 text-left font-semibold text-brand-navy align-top">
                      {t.term}
                    </th>
                    <td className="px-4 sm:px-6 py-3 text-brand-navy/70 leading-relaxed">
                      {t.definition}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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
