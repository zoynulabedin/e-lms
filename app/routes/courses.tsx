import { redirect, useLoaderData, useFetcher, Link, data } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { useState, useEffect } from "react";
import {
  Plus,
  BookOpen,
  MonitorPlay,
  Video,
  DollarSign,
  Gift,
  Eye,
  EyeOff,
  Globe,
  Tag,
  User,
  X,
  Edit3,
  Trash2,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "desc" },
    // Explicit select (not `include`): `include` would pull every scalar
    // column, so a column from an unapplied migration would 500 this page.
    select: {
      id: true,
      title: true,
      summary: true,
      category: true,
      instructor: true,
      courseType: true,
      price: true,
      status: true,
      contentType: true,
      thumbnailUrl: true,
      _count: {
        select: { licenses: true, progress: true, modules: true, enrollments: true },
      },
    },
  });

  // Keys that came from real Shopify orders. A course holding any of these can
  // never be deleted, so the list can say so instead of letting an admin walk
  // into a refusal.
  const paidGroups = await prisma.license
    .groupBy({
      by: ["courseId"],
      where: { shopifyOrderId: { not: null } },
      _count: { _all: true },
    })
    .catch(() => [] as Array<{ courseId: string; _count: { _all: number } }>);
  const paidByCourse: Record<string, number> = {};
  for (const g of paidGroups) paidByCourse[g.courseId] = g._count._all;

  return { courses, paidByCourse };
}


// ── Delete a course ─────────────────────────────────────────────────

/**
 * A dialog rather than window.confirm: deleting a course takes its licences,
 * enrolments and every learner's progress with it, and the admin needs to see
 * those numbers before deciding. A course holding keys from real Shopify
 * orders cannot be deleted at all, and says so instead of offering a button.
 */
function DeleteCourseDialog({
  course,
  paidKeys,
  onClose,
  onDone,
}: {
  course: any;
  paidKeys: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const fetcher = useFetcher<any>();
  const [typed, setTyped] = useState("");
  const busy = fetcher.state !== "idle";

  const licenses = course._count?.licenses ?? 0;
  const enrolments = course._count?.enrollments ?? 0;
  const progress = course._count?.progress ?? 0;
  const modules = course._count?.modules ?? 0;
  const hasData = licenses > 0 || enrolments > 0 || progress > 0;
  const blocked = paidKeys > 0;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      onDone(fetcher.data.message ?? "Course deleted.");
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = [
    { label: "Module" + (modules === 1 ? "" : "s"), n: modules },
    { label: "License key" + (licenses === 1 ? "" : "s"), n: licenses },
    { label: "Enrolment" + (enrolments === 1 ? "" : "s"), n: enrolments },
    { label: "Progress record" + (progress === 1 ? "" : "s"), n: progress },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Trash2 size={16} className="text-red-600" /> Delete course
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <p className="font-semibold text-gray-900">{course.title}</p>

          {fetcher.data?.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 text-sm">
              {fetcher.data.error}
            </div>
          )}

          {blocked ? (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm space-y-2">
              <p className="font-semibold">
                This course cannot be deleted.
              </p>
              <p>
                {paidKeys} of its license key{paidKeys === 1 ? " is" : "s are"} from
                real Shopify order{paidKeys === 1 ? "" : "s"}. Deleting the course
                would destroy those purchases, and Shopify still counts those
                orders as processed, so the keys could never be re-issued.
              </p>
              <p>Unpublish it instead, or delete the individual keys first.</p>
            </div>
          ) : (
            <>
              {hasData ? (
                <>
                  <p className="text-sm text-gray-600">
                    These go with it, permanently:
                  </p>
                  <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
                    {rows.map((r) => (
                      <li key={r.label} className="flex justify-between px-4 py-2">
                        <span className="text-gray-600">{r.label}</span>
                        <span className={r.n > 0 ? "font-semibold text-gray-900" : "text-gray-400"}>
                          {r.n}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-gray-500">
                    No key here came from a Shopify order, so nothing that was paid
                    for is lost \u2014 this is test data.
                  </p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Type <span className="font-mono font-semibold">DELETE</span> to confirm
                    </label>
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoFocus
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-red-500"
                      placeholder="DELETE"
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-gray-600">
                  Nobody holds a key for this course and nobody has started it, so
                  only the course and its {modules} module{modules === 1 ? "" : "s"} go.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-200 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            {blocked ? "Close" : "Cancel"}
          </button>
          {!blocked && (
            <button
              type="button"
              disabled={busy || (hasData && typed !== "DELETE")}
              onClick={() =>
                fetcher.submit(
                  { intent: "delete", id: course.id, confirm: hasData ? typed : "" },
                  { method: "post" },
                )
              }
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              <Trash2 size={14} /> Delete course
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const title = (formData.get("title") as string)?.trim();
    if (!title) return data({ error: "Title is required." }, { status: 400 });
    const course = await prisma.course.create({ data: { title } });
    throw redirect(`/courses/${course.id}`);
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;

    // Deleting a course cascades to every License, Enrollment, Progress,
    // Module/Lesson/Quiz and the attempts underneath them. Two tiers:
    //
    //   • A key from a real Shopify order is money that changed hands, and the
    //     order stays claimed in ShopifyOrder so the licence could never be
    //     re-minted. That is refused outright, with no override.
    //   • Everything else is admin-generated test data. It still needs the
    //     typed confirmation, but an admin who made a test course has to be
    //     able to get rid of it.
    const course = await prisma.course.findUnique({
      where: { id },
      select: {
        title: true,
        _count: {
          select: { licenses: true, enrollments: true, progress: true, modules: true },
        },
      },
    });
    if (!course) return data({ error: "Course not found." }, { status: 404 });

    const paidKeys = await prisma.license.count({
      where: { courseId: id, shopifyOrderId: { not: null } },
    });
    if (paidKeys > 0) {
      return data(
        {
          error:
            `"${course.title}" has ${paidKeys} license key(s) from real Shopify orders. ` +
            `Deleting the course would destroy those purchases, and the orders stay marked ` +
            `as processed so the keys could never be re-issued. Unpublish it instead.`,
        },
        { status: 400 },
      );
    }

    const { licenses, enrollments, progress } = course._count;
    const hasData = licenses > 0 || enrollments > 0 || progress > 0;

    if (hasData && formData.get("confirm") !== "DELETE") {
      return data(
        {
          error:
            `"${course.title}" has ${licenses} license key(s), ${enrollments} enrolment(s) ` +
            `and ${progress} progress record(s). Deleting removes all of them along with the ` +
            `course. Type DELETE to confirm, or unpublish it instead.`,
          needsConfirm: true,
        },
        { status: 400 },
      );
    }

    await prisma.course.delete({ where: { id } });

    // No audit table in this app; a log line is the only record of what went.
    console.warn(
      `[courses] ${admin.email} deleted course "${course.title}" ` +
        `(${course._count.modules} module(s), ${licenses} licence(s), ` +
        `${enrollments} enrolment(s), ${progress} progress record(s))`,
    );

    return data({
      success: true,
      message: hasData
        ? `"${course.title}" and its ${licenses} key(s), ${enrollments} enrolment(s) and ${progress} progress record(s) were deleted.`
        : `"${course.title}" deleted.`,
    });
  }

  if (intent === "set_status") {
    const id = formData.get("id") as string;
    const status = formData.get("status");
    if (status !== "DRAFT" && status !== "PUBLISHED")
      return data({ error: "Invalid status." }, { status: 400 });
    await prisma.course.update({
      where: { id },
      // Publishing from the list also lists the course; un-listing is an
      // explicit choice made with the builder's "Public Course" toggle.
      data: status === "PUBLISHED" ? { status, isPublic: true } : { status },
    });
    return data({ success: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ── Badges ────────────────────────────────────────────────────────────────────

function ContentBadge({ type }: { type: string }) {
  const isStoryline = type === "STORYLINE";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
        ${isStoryline ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}
    >
      {isStoryline ? <MonitorPlay size={10} /> : <Video size={10} />}
      {isStoryline ? "Storyline" : "Video"}
    </span>
  );
}

function CourseTypeBadge({ type }: { type: string }) {
  const isFree = type === "FREE";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
        ${isFree ? "bg-brand-green/10 text-brand-green-dark" : "bg-amber-100 text-amber-700"}`}
    >
      {isFree ? <Gift size={10} /> : <DollarSign size={10} />}
      {isFree ? "Free" : "Paid"}
    </span>
  );
}

// ── Quick Create Modal ────────────────────────────────────────────────────────

function QuickCreateModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <BookOpen size={16} className="text-brand-navy" />
            New Course
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <form method="post" action="/courses" className="p-6 space-y-4">
          <input type="hidden" name="intent" value="create" />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Course Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="title"
              autoFocus
              required
              placeholder="e.g. Advanced Onboarding Training"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy"
            />
            <p className="text-xs text-gray-400 mt-1.5">
              You can fill in all other details in the course builder.
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark shadow-sm"
            >
              Create & Edit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CourseManagement() {
  const { courses, paidByCourse } = useLoaderData<typeof loader>();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  /** The course the admin is about to delete, or null when the dialog is shut. */
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fetcher = useFetcher<typeof action>();
  const toggleFetcher = useFetcher();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">Course Library</h1>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-2 bg-brand-navy text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-brand-navy-dark transition-colors shadow-sm"
        >
          <Plus size={16} /> Add Course
        </button>
      </div>

      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {fetcher.data.error}
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {courses.map((course: any) => {
          const isStoryline = course.contentType === "STORYLINE";
          const isPublished = course.status === "PUBLISHED";

          return (
            <div
              key={course.id}
              className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col hover:shadow-md transition-shadow"
            >
              {/* Thumbnail */}
              <div
                className={`h-36 flex items-center justify-center relative overflow-hidden ${
                  isStoryline
                    ? "bg-gradient-to-br from-purple-50 to-purple-100"
                    : "bg-gradient-to-br from-blue-50 to-blue-100"
                }`}
              >
                {course.thumbnailUrl ? (
                  <img
                    src={course.thumbnailUrl}
                    alt={course.title}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : isStoryline ? (
                  <MonitorPlay size={36} className="text-purple-300" />
                ) : (
                  <Video size={36} className="text-blue-300" />
                )}
                <div className="absolute top-2 left-2 flex flex-col gap-1">
                  <ContentBadge type={course.contentType} />
                  <CourseTypeBadge type={course.courseType} />
                </div>
                <span
                  className={`absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase border
                    ${isPublished ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200"}`}
                >
                  {isPublished ? <Eye size={10} /> : <EyeOff size={10} />}
                  {isPublished ? "Published" : "Draft"}
                </span>
              </div>

              {/* Body */}
              <div className="p-4 flex-1 flex flex-col">
                <h3
                  className="text-sm font-semibold text-gray-900 mb-0.5 line-clamp-1 leading-snug"
                  title={course.title}
                >
                  {course.title}
                </h3>

                {(course.category || course.instructor) && (
                  <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1.5 flex-wrap">
                    {course.category && (
                      <span className="flex items-center gap-0.5">
                        <Tag size={10} /> {course.category}
                      </span>
                    )}
                    {course.instructor && (
                      <span className="flex items-center gap-0.5">
                        <User size={10} /> {course.instructor}
                      </span>
                    )}
                  </div>
                )}

                {course.summary && (
                  <p className="text-xs text-gray-500 mb-2 line-clamp-2">
                    {course.summary}
                  </p>
                )}

                {course.courseType === "PAID" && course.price !== null && (
                  <p className="text-xs font-semibold text-amber-600 mb-2">
                    ${course.price.toFixed(2)} USD
                  </p>
                )}

                <div className="flex gap-3 text-xs text-gray-400 mb-3">
                  <span>{course._count.licenses} licences</span>
                  <span>·</span>
                  <span>{course._count.progress} enrolled</span>
                  <span>·</span>
                  <span>{course._count.modules} modules</span>
                </div>

                {/* Actions */}
                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
                  <Link
                    to={`/courses/${course.id}`}
                    className="flex items-center gap-1 text-brand-navy hover:text-brand-navy-dark hover:bg-green-50 px-2 py-1 rounded-lg text-xs font-medium transition-colors border border-transparent hover:border-green-200"
                  >
                    <Edit3 size={12} /> Edit Course
                  </Link>
                  <toggleFetcher.Form method="post" className="ml-auto">
                    <input type="hidden" name="intent" value="set_status" />
                    <input type="hidden" name="id" value={course.id} />
                    <input type="hidden" name="status" value={isPublished ? "DRAFT" : "PUBLISHED"} />
                    <button
                      type="submit"
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors border ${
                        isPublished
                          ? "text-gray-400 hover:text-gray-600 hover:bg-gray-50 border-transparent hover:border-gray-200"
                          : "text-brand-green hover:text-brand-green-dark hover:bg-brand-green/10 border-transparent hover:border-brand-green/20"
                      }`}
                    >
                      {isPublished ? (
                        <>
                          <EyeOff size={12} /> Unpublish
                        </>
                      ) : (
                        <>
                          <Globe size={12} /> Publish
                        </>
                      )}
                    </button>
                  </toggleFetcher.Form>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(course)}
                    className="flex items-center gap-1 text-red-400 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded-lg text-xs font-medium border border-transparent hover:border-red-100"
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {courses.length === 0 && (
          <div className="col-span-full bg-white rounded-xl p-12 text-center border-2 border-dashed border-gray-200">
            <BookOpen className="mx-auto h-12 w-12 text-gray-300 mb-3" />
            <h3 className="text-base font-semibold text-gray-900 mb-1">
              No courses yet
            </h3>
            <p className="text-sm text-gray-500 mb-5">
              Add your first course to get started.
            </p>
            <button
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex items-center gap-2 bg-brand-navy text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-navy-dark shadow-sm"
            >
              <Plus size={15} /> Add Course
            </button>
          </div>
        )}
      </div>

      {notice && (

        <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-2.5 text-sm flex items-start gap-2">

          <span className="flex-1">{notice}</span>

          <button onClick={() => setNotice(null)} className="text-green-700/60 hover:text-green-900" aria-label="Dismiss">

            <X size={14} />

          </button>

        </div>

      )}


      {pendingDelete && (

        <DeleteCourseDialog

          course={pendingDelete}

          paidKeys={paidByCourse[pendingDelete.id] ?? 0}

          onClose={() => setPendingDelete(null)}

          onDone={setNotice}

        />

      )}

      {isCreateOpen && (
        <QuickCreateModal onClose={() => setIsCreateOpen(false)} />
      )}
    </div>
  );
}
