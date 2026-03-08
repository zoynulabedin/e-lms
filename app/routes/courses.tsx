import { redirect } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { useState } from "react";
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
    include: {
      _count: { select: { licenses: true, progress: true, modules: true } },
    },
  });
  return { courses };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const title = (formData.get("title") as string)?.trim();
    if (!title) return data({ error: "Title is required." }, { status: 400 });
    const course = await prisma.course.create({
      data: { title, status: "DRAFT", isPublic: false },
    });
    return redirect(`/courses/${course.id}`);
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    await prisma.course.delete({ where: { id } });
    return data({ success: true });
  }

  if (intent === "toggle_status") {
    const id = formData.get("id") as string;
    const current = formData.get("current") as string;
    const newStatus = current === "PUBLISHED" ? "DRAFT" : "PUBLISHED";
    await prisma.course.update({
      where: { id },
      data: { status: newStatus as any, isPublic: newStatus === "PUBLISHED" },
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
        ${isFree ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
    >
      {isFree ? <Gift size={10} /> : <DollarSign size={10} />}
      {isFree ? "Free" : "Paid"}
    </span>
  );
}

// ── Quick Create Modal ────────────────────────────────────────────────────────

function QuickCreateModal({
  onClose,
  fetcher,
}: {
  onClose: () => void;
  fetcher: any;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <BookOpen size={16} className="text-[#008060]" />
            New Course
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <fetcher.Form method="post" className="p-6 space-y-4">
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
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#008060] focus:ring-1 focus:ring-[#008060]"
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
              disabled={fetcher.state === "submitting"}
              className="px-5 py-2 text-sm font-medium text-white bg-[#008060] rounded-lg hover:bg-[#006e52] disabled:opacity-60 shadow-sm"
            >
              {fetcher.state === "submitting" ? "Creating…" : "Create & Edit"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CourseManagement() {
  const { courses } = useLoaderData<typeof loader>();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const fetcher = useFetcher<typeof action>();
  const toggleFetcher = useFetcher();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">Course Library</h1>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-2 bg-[#008060] text-white px-4 py-2 rounded-lg font-medium text-sm hover:bg-[#006e52] transition-colors shadow-sm"
        >
          <Plus size={16} /> Add Course
        </button>
      </div>

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
                    className="flex items-center gap-1 text-[#008060] hover:text-[#006e52] hover:bg-green-50 px-2 py-1 rounded-lg text-xs font-medium transition-colors border border-transparent hover:border-green-200"
                  >
                    <Edit3 size={12} /> Edit Course
                  </Link>
                  <toggleFetcher.Form method="post" className="ml-auto">
                    <input type="hidden" name="intent" value="toggle_status" />
                    <input type="hidden" name="id" value={course.id} />
                    <input type="hidden" name="current" value={course.status} />
                    <button
                      type="submit"
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors border ${
                        isPublished
                          ? "text-gray-400 hover:text-gray-600 hover:bg-gray-50 border-transparent hover:border-gray-200"
                          : "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border-transparent hover:border-emerald-200"
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
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={course.id} />
                    <button
                      type="submit"
                      onClick={(e) => {
                        if (
                          !confirm(
                            `Delete "${course.title}"? This cannot be undone.`,
                          )
                        )
                          e.preventDefault();
                      }}
                      className="flex items-center gap-1 text-red-400 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded-lg text-xs font-medium border border-transparent hover:border-red-100"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </fetcher.Form>
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
              className="inline-flex items-center gap-2 bg-[#008060] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#006e52] shadow-sm"
            >
              <Plus size={15} /> Add Course
            </button>
          </div>
        )}
      </div>

      {isCreateOpen && (
        <QuickCreateModal
          fetcher={fetcher}
          onClose={() => setIsCreateOpen(false)}
        />
      )}
    </div>
  );
}
