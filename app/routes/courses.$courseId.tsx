import { redirect } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { isIconSet, iconSetImages } from "../utils/module-icons";
import { recomputeCourseProgressForAllUsers } from "../utils/progress.server";
import { normalizeModuleOrder } from "../utils/curriculum.server";
import { useState, useRef, useEffect } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Paperclip,
  BookMarked,
  Link2,
  Loader2,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  MonitorPlay,
  Video,
  FileText,
  Download,
  GripVertical,
  BookOpen,
  X,
  Cloud,
  ChevronUp,
  Trash2,
  Edit3,
  Plus,
  HelpCircle,
  Image,
  Play,
  Globe,
} from "lucide-react";

// ── ImageUpload ───────────────────────────────────────────────────────────────

function ImageUpload({
  name,
  defaultValue = "",
  label = "Upload Image",
}: {
  name: string;
  defaultValue?: string;
  label?: string;
}) {
  const [url, setUrl] = useState(defaultValue);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? "Upload failed");
      setUrl(json.url);
    } catch (err: any) {
      setError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={url} />
      {url ? (
        <div className="relative group">
          <img src={url} alt="uploaded" className="w-full h-32 object-cover rounded-lg border border-gray-200" />
          <button
            type="button"
            onClick={() => setUrl("")}
            className="absolute top-1.5 right-1.5 bg-white rounded-full p-1 shadow opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X size={12} className="text-gray-600" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full h-32 bg-gray-50 border-2 border-dashed border-gray-200 rounded-lg flex flex-col items-center justify-center hover:bg-gray-100 transition-colors disabled:opacity-60"
        >
          {uploading ? (
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-1" />
          ) : (
            <Image size={22} className="text-gray-300 mb-1" />
          )}
          <p className="text-xs text-gray-400">{uploading ? "Uploading…" : label}</p>
        </button>
      )}
      {!url && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-1.5 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-60"
        >
          <Image size={13} /> Choose file
        </button>
      )}
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" className="hidden" onChange={handleFile} />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <p className="text-[11px] text-gray-400">JPEG, PNG, GIF, WebP — max 10 MB</p>
    </div>
  );
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const { courseId } = params;

  // Explicit select: an `include` pulls every scalar column, so a column added
  // by a migration that has not been applied yet would 500 the whole builder.
  // Fields added later are read separately below and tolerate being absent.
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      title: true,
      summary: true,
      description: true,
      category: true,
      instructor: true,
      courseType: true,
      price: true,
      shopifyProductId: true,
      status: true,
      contentType: true,
      embedUrl: true,
      videoUrl: true,
      introVideoUrl: true,
      thumbnailUrl: true,
      isPublic: true,
      updatedAt: true,
      modules: {
        orderBy: { order: "asc" },
        include: { lessons: { orderBy: { order: "asc" } } },
      },
    },
  });
  if (!course) throw data({ message: "Course not found." }, { status: 404 });

  // New Course fields — bypass stale client validation
  const [extras] = await prisma.$queryRaw<Array<{
    difficulty: string | null; isQA: boolean;
    whatYouLearn: string | null; targetAudience: string | null;
    materialsIncluded: string | null; requirements: string | null;
  }>>`
    SELECT difficulty, "isQA", "whatYouLearn", "targetAudience",
           "materialsIncluded", requirements
    FROM "Course" WHERE id = ${courseId}
  `;

  // Resources and glossary are read on their own and tolerate being absent so
  // the builder still opens on a server that has not migrated/generated yet.
  const resources = await prisma.courseResource
    .findMany({
      where: { courseId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, title: true, description: true, kind: true, url: true,
        fileName: true, fileType: true, fileSize: true, lessonId: true,
        isActive: true, order: true,
      },
    })
    .catch(() => [] as any[]);
  const glossary = await prisma.glossaryTerm
    .findMany({ where: { courseId }, orderBy: [{ term: "asc" }] })
    .catch(() => [] as any[]);

  // Added by a later migration: read it on its own so the builder still opens
  // on a server whose migrations have not been applied yet.
  const iconSet = await prisma
    .$queryRaw<Array<{ iconSet: string | null }>>`SELECT "iconSet" FROM "Course" WHERE id = ${courseId}`
    .then((rows) => rows[0]?.iconSet ?? null)
    .catch(() => null);

  // Quizzes with questions + answers via $queryRaw
  const quizRows = await prisma.$queryRaw<Array<any>>`
    SELECT q.* FROM "Quiz" q
    INNER JOIN "Module" m ON q."moduleId" = m.id
    WHERE m."courseId" = ${courseId}
    ORDER BY q."order" ASC
  `;

  const quizzesByModule = new Map<string, any[]>();
  if (quizRows.length > 0) {
    const quizIds = quizRows.map((q: any) => q.id);
    const questionRows = await prisma.$queryRaw<Array<any>>`
      SELECT * FROM "Question"
      WHERE "quizId" IN (${Prisma.join(quizIds)})
      ORDER BY "order" ASC
    `;
    const answerRows = questionRows.length > 0
      ? await prisma.$queryRaw<Array<any>>`
          SELECT * FROM "Answer"
          WHERE "questionId" IN (${Prisma.join(questionRows.map((q: any) => q.id))})
          ORDER BY "order", id
        `
      : [];

    const answersByQuestion = new Map<string, any[]>();
    for (const ans of answerRows as any[]) {
      const arr = answersByQuestion.get(ans.questionId) ?? [];
      arr.push(ans);
      answersByQuestion.set(ans.questionId, arr);
    }
    const questionsByQuiz = new Map<string, any[]>();
    for (const q of questionRows as any[]) {
      const arr = questionsByQuiz.get(q.quizId) ?? [];
      arr.push({ ...q, answers: answersByQuestion.get(q.id) ?? [] });
      questionsByQuiz.set(q.quizId, arr);
    }
    for (const quiz of quizRows as any[]) {
      const arr = quizzesByModule.get(quiz.moduleId) ?? [];
      arr.push({ ...quiz, questions: questionsByQuiz.get(quiz.id) ?? [] });
      quizzesByModule.set(quiz.moduleId, arr);
    }
  }

  return {
    resources,
    glossary,
    course: {
      ...course,
      ...(extras ?? {}),
      modules: course.modules.map((m) => ({
        ...m,
        quizzes: quizzesByModule.get(m.id) ?? [],
      })),
    },
  };
}

// ── Action ────────────────────────────────────────────────────────────────────

const QUESTION_TYPE_VALUES = [
  "MULTIPLE_CHOICE", "TRUE_FALSE", "FILL_BLANK", "SHORT_ANSWER", "ESSAY",
  "MATCHING", "ORDERING", "IMAGE_ANSWERING", "VIDEO_ANSWERING",
] as const;
const isQuestionType = (v: unknown): v is (typeof QUESTION_TYPE_VALUES)[number] =>
  QUESTION_TYPE_VALUES.includes(v as any);

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdmin(request);
  const courseId = params.courseId;
  if (!courseId) return data({ error: "Course id missing." }, { status: 400 });
  const formData = await request.formData();

  // Ownership helpers: every question/answer id posted must belong to THIS
  // course, otherwise an admin form could be replayed against another course.
  const questionInCourse = async (id: string) =>
    !!id && (await prisma.question.count({ where: { id, quiz: { module: { courseId } } } })) > 0;
  const answerInCourse = async (id: string) =>
    !!id && (await prisma.answer.count({ where: { id, question: { quiz: { module: { courseId } } } } })) > 0;
  const intent = formData.get("intent") as string;

  // ── Basics ────────────────────────────────────────────────────────────────
  if (intent === "update_basics") {
    const title = (formData.get("title") as string)?.trim();
    const summary = (formData.get("summary") as string)?.trim() || null;
    const description = (formData.get("description") as string)?.trim() || null;
    const category = (formData.get("category") as string)?.trim() || null;
    const instructor = (formData.get("instructor") as string)?.trim() || null;
    const difficulty = (formData.get("difficulty") as string) || null;
    const isQA = formData.get("isQA") === "true";
    const iconSetRaw = String(formData.get("iconSet") || "");
    const iconSet = iconSetRaw === "market" || iconSetRaw === "money" ? iconSetRaw : null;
    const isPublicCourse = formData.get("isPublicCourse") === "true";
    const contentTypeRaw = (formData.get("contentType") as string) || "STORYLINE";
    const courseTypeRaw = (formData.get("courseType") as string) || "FREE";
    if (contentTypeRaw !== "STORYLINE" && contentTypeRaw !== "VIDEO")
      return data({ error: "Invalid content type." }, { status: 400 });
    if (courseTypeRaw !== "FREE" && courseTypeRaw !== "PAID")
      return data({ error: "Invalid course type." }, { status: 400 });
    const contentType = contentTypeRaw;
    const courseType = courseTypeRaw;
    const priceRaw = formData.get("price") as string;
    const price = priceRaw ? parseFloat(priceRaw) : null;
    const shopifyProductId = (formData.get("shopifyProductId") as string)?.trim() || null;
    const embedUrl = (formData.get("embedUrl") as string)?.trim() || null;
    const videoUrl = (formData.get("videoUrl") as string)?.trim() || null;
    const introVideoUrl = (formData.get("introVideoUrl") as string)?.trim() || null;
    const thumbnailUrl = (formData.get("thumbnailUrl") as string)?.trim() || null;
    // Status is optional here: only "DRAFT"/"PUBLISHED" are accepted, anything
    // else leaves the current value untouched (COALESCE below).
    const statusVal = formData.get("status");
    const status =
      statusVal === "DRAFT" || statusVal === "PUBLISHED" ? statusVal : null;

    if (!title) return data({ error: "Title is required." }, { status: 400 });
    const finalPrice = courseType === "PAID" ? price : null;
    const finalShopifyId = courseType === "PAID" ? shopifyProductId : null;
    const isPublic = isPublicCourse;
    await prisma.$executeRaw`
      UPDATE "Course" SET
        title = ${title},
        summary = ${summary},
        description = ${description},
        category = ${category},
        instructor = ${instructor},
        difficulty = ${difficulty},
        "isQA" = ${isQA},
        "iconSet" = ${iconSet},
        "contentType" = ${contentType}::"ContentType",
        "courseType" = ${courseType}::"CourseType",
        price = ${finalPrice},
        "shopifyProductId" = ${finalShopifyId},
        "embedUrl" = ${embedUrl},
        "videoUrl" = ${videoUrl},
        "introVideoUrl" = ${introVideoUrl},
        "thumbnailUrl" = ${thumbnailUrl},
        status = COALESCE(${status}::"CourseStatus", status),
        "isPublic" = ${isPublic},
        "updatedAt" = NOW()
      WHERE id = ${courseId}
    `;
    return data({ success: true });
  }

  // ── Additional ────────────────────────────────────────────────────────────
  if (intent === "update_additional") {
    const whatYouLearn = (formData.get("whatYouLearn") as string)?.trim() || null;
    const targetAudience = (formData.get("targetAudience") as string)?.trim() || null;
    const materialsIncluded = (formData.get("materialsIncluded") as string)?.trim() || null;
    const requirements = (formData.get("requirements") as string)?.trim() || null;
    await prisma.$executeRaw`
      UPDATE "Course" SET
        "whatYouLearn" = ${whatYouLearn},
        "targetAudience" = ${targetAudience},
        "materialsIncluded" = ${materialsIncluded},
        requirements = ${requirements},
        "updatedAt" = NOW()
      WHERE id = ${courseId}
    `;
    return data({ success: true });
  }

  // ── Status ───────────────────────────────────────────────────────────────
  // Explicit target status — never "flip whatever the client says is current",
  // which let a stale form publish a draft (or un-publish a live course).
  if (intent === "set_status") {
    const status = formData.get("status");
    if (status !== "DRAFT" && status !== "PUBLISHED")
      return data({ error: "Invalid status." }, { status: 400 });
    await prisma.course.update({
      where: { id: courseId },
      data: { status },
    });
    return data({ success: true });
  }

  // ── Modules ───────────────────────────────────────────────────────────────
  if (intent === "create_module") {
    const title = (formData.get("title") as string)?.trim();
    if (!title) return data({ error: "Module title is required." }, { status: 400 });
    const count = await prisma.module.count({ where: { courseId } });
    await prisma.module.create({ data: { courseId: courseId!, title, order: count } });
    return data({ success: true });
  }

  if (intent === "update_module") {
    const id = formData.get("id") as string;
    const title = (formData.get("title") as string)?.trim();
    if (!id || !title) return data({ error: "ID and title required." }, { status: 400 });
    await prisma.module.update({ where: { id }, data: { title } });
    return data({ success: true });
  }

  if (intent === "delete_module") {
    const id = formData.get("id") as string;
    const r = await prisma.module.deleteMany({ where: { id, courseId } });
    if (r.count === 0) return data({ error: "Module not found." }, { status: 404 });
    await recomputeCourseProgressForAllUsers(courseId);
    return data({ success: true });
  }

  // ── Lessons ───────────────────────────────────────────────────────────────
  if (intent === "create_lesson" || intent === "update_lesson") {
    const moduleId = formData.get("moduleId") as string;
    const lessonId = formData.get("lessonId") as string;
    const title = (formData.get("title") as string)?.trim();
    const lessonType = (formData.get("lessonType") as string) || "VIDEO";
    const videoUrl = (formData.get("videoUrl") as string)?.trim() || null;
    const iframeEmbed = (formData.get("iframeEmbed") as string)?.trim() || null;
    const embedUrl = (formData.get("embedUrl") as string)?.trim() || null;
    const resourceUrl = (formData.get("resourceUrl") as string)?.trim() || null;
    const content = (formData.get("content") as string)?.trim() || null;
    const thumbnailUrl = (formData.get("thumbnailUrl") as string)?.trim() || null;
    const h = parseInt(formData.get("durationH") as string || "0", 10) || 0;
    const m = parseInt(formData.get("durationM") as string || "0", 10) || 0;
    const s = parseInt(formData.get("durationS") as string || "0", 10) || 0;
    const duration = h * 3600 + m * 60 + s || null;

    if (!title) return data({ error: "Lesson title is required." }, { status: 400 });

    if (intent === "create_lesson") {
      const mod = await prisma.module.findFirst({ where: { id: moduleId, courseId }, select: { id: true } });
      if (!mod) return data({ error: "Module not found." }, { status: 400 });
      const count = await prisma.lesson.count({ where: { moduleId } });
      await prisma.lesson.create({
        data: { moduleId, title, lessonType: lessonType as any, videoUrl, iframeEmbed, embedUrl, resourceUrl, content, thumbnailUrl, duration, order: count },
      });
      await normalizeModuleOrder(moduleId);
      // A new lesson changes every learner's denominator.
      await recomputeCourseProgressForAllUsers(courseId);
    } else {
      const r = await prisma.lesson.updateMany({
        where: { id: lessonId, module: { courseId } },
        data: { title, lessonType: lessonType as any, videoUrl, iframeEmbed, embedUrl, resourceUrl, content, thumbnailUrl, duration },
      });
      if (r.count === 0) return data({ error: "Lesson not found." }, { status: 404 });
    }
    return data({ success: true });
  }

  if (intent === "delete_lesson") {
    const id = formData.get("id") as string;
    const lesson = await prisma.lesson.findFirst({ where: { id, module: { courseId } }, select: { moduleId: true } });
    if (!lesson) return data({ error: "Lesson not found." }, { status: 404 });
    await prisma.lesson.delete({ where: { id } });
    await normalizeModuleOrder(lesson.moduleId);
    await recomputeCourseProgressForAllUsers(courseId);
    return data({ success: true });
  }

  if (intent === "reorder_lessons" || intent === "reorder_modules") {
    let items: Array<{ id: string; order: number }>;
    try {
      items = JSON.parse(String(formData.get("items") ?? ""));
    } catch {
      return data({ error: "Bad reorder payload." }, { status: 400 });
    }
    if (
      !Array.isArray(items) ||
      !items.every((i) => i && typeof i.id === "string" && Number.isInteger(i.order) && i.order >= 0)
    )
      return data({ error: "Bad reorder payload." }, { status: 400 });

    if (intent === "reorder_modules") {
      await prisma.$transaction(
        items.map(({ id, order }) => prisma.module.updateMany({ where: { id, courseId }, data: { order } })),
      );
      return data({ success: true });
    }

    // Only lessons of this course; then re-pack the touched modules so quizzes
    // keep following their lessons.
    await prisma.$transaction(
      items.map(({ id, order }) =>
        prisma.lesson.updateMany({ where: { id, module: { courseId } }, data: { order } }),
      ),
    );
    const touched = await prisma.lesson.findMany({
      where: { id: { in: items.map((i) => i.id) }, module: { courseId } },
      select: { moduleId: true },
      distinct: ["moduleId"],
    });
    for (const { moduleId } of touched) await normalizeModuleOrder(moduleId);
    return data({ success: true });
  }

  // ── Quizzes ───────────────────────────────────────────────────────────────
  if (intent === "create_quiz" || intent === "update_quiz") {
    const isCreate = intent === "create_quiz";
    const moduleId = formData.get("moduleId") as string;
    const quizId = formData.get("quizId") as string;

    // Field readers. On CREATE a missing field gets its default; on UPDATE a
    // missing field yields null so COALESCE keeps the stored value — the
    // Details tab (title/summary) and Settings tab post different subsets and
    // must not wipe each other. Out-of-range values are rejected, and a valid
    // 0 is no longer swallowed by `|| default`.
    const invalid: string[] = [];
    const intField = (name: string, def: number, min: number, max: number): number | null => {
      if (!formData.has(name)) return isCreate ? def : null;
      const raw = String(formData.get(name) ?? "").trim();
      if (raw === "") return isCreate ? def : null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) { invalid.push(`${name} must be ${min}–${max}`); return null; }
      return n;
    };
    const boolField = (name: string): boolean | null =>
      formData.has(name) ? formData.get(name) === "true" : isCreate ? false : null;
    const enumField = (name: string, allowed: readonly string[], def: string): string | null => {
      if (!formData.has(name)) return isCreate ? def : null;
      const v = String(formData.get(name));
      if (!allowed.includes(v)) { invalid.push(`${name} is invalid`); return null; }
      return v;
    };

    const title = formData.has("title")
      ? (String(formData.get("title")).trim() || "Quiz")
      : isCreate ? "Quiz" : null;
    const summary = formData.has("summary")
      ? (String(formData.get("summary")).trim() || null)
      : null; // absent on update → keep (COALESCE); absent on create → NULL
    const timeLimit = intField("timeLimit", 0, 0, 24 * 60);
    const hideQuizTime = boolField("hideQuizTime");
    const feedbackMode = enumField("feedbackMode", ["RETRY", "REVEAL", "DEFAULT"], "RETRY");
    const attemptsAllowed = intField("attemptsAllowed", 10, 0, 1000); // 0 = unlimited
    const passingGrade = intField("passingGrade", 80, 0, 100);
    const maxQuestionsAllowed = intField("maxQuestionsAllowed", 10, 0, 1000);
    const autoStart = boolField("autoStart");
    const questionLayout = enumField("questionLayout", ["SINGLE", "ALL"], "SINGLE");
    const questionOrder = enumField("questionOrder", ["RANDOM", "SEQUENTIAL"], "RANDOM");
    const hideQuestionNumber = boolField("hideQuestionNumber");
    const shortAnswerCharLimit = intField("shortAnswerCharLimit", 200, 1, 10000);
    const essayCharLimit = intField("essayCharLimit", 500, 1, 50000);

    if (invalid.length)
      return data({ error: invalid.join("; ") }, { status: 400 });

    if (isCreate) {
      if (!moduleId) return data({ error: "Module is required." }, { status: 400 });
      const mod = await prisma.module.findFirst({ where: { id: moduleId, courseId }, select: { id: true } });
      if (!mod) return data({ error: "Module not found." }, { status: 400 });
      // Provisional order: after every lesson AND quiz in the module. normalizeModuleOrder re-packs it.
      const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT (SELECT COUNT(*) FROM "Lesson" WHERE "moduleId" = ${moduleId})
             + (SELECT COUNT(*) FROM "Quiz"   WHERE "moduleId" = ${moduleId}) AS count
      `;
      const newId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "Quiz" (id, "moduleId", title, summary, "order", "timeLimit", "hideQuizTime",
          "feedbackMode", "attemptsAllowed", "passingGrade", "maxQuestionsAllowed", "autoStart",
          "questionLayout", "questionOrder", "hideQuestionNumber", "shortAnswerCharLimit",
          "essayCharLimit", "createdAt", "updatedAt")
        VALUES (${newId}, ${moduleId}, ${title}, ${summary}, ${Number(count)}, ${timeLimit},
          ${hideQuizTime}, ${feedbackMode}::"FeedbackMode", ${attemptsAllowed}, ${passingGrade},
          ${maxQuestionsAllowed}, ${autoStart}, ${questionLayout}, ${questionOrder},
          ${hideQuestionNumber}, ${shortAnswerCharLimit}, ${essayCharLimit}, NOW(), NOW())
      `;
      await normalizeModuleOrder(moduleId);
      await recomputeCourseProgressForAllUsers(courseId);
    } else {
      if (!quizId) return data({ error: "Quiz id is required." }, { status: 400 });
      const summaryProvided = formData.has("summary");
      const n = await prisma.$executeRaw`
        UPDATE "Quiz" SET
          title = COALESCE(${title}::text, title),
          summary = CASE WHEN ${summaryProvided}::boolean THEN ${summary}::text ELSE summary END,
          "timeLimit" = COALESCE(${timeLimit}::int, "timeLimit"),
          "hideQuizTime" = COALESCE(${hideQuizTime}::boolean, "hideQuizTime"),
          "feedbackMode" = COALESCE(${feedbackMode}::"FeedbackMode", "feedbackMode"),
          "attemptsAllowed" = COALESCE(${attemptsAllowed}::int, "attemptsAllowed"),
          "passingGrade" = COALESCE(${passingGrade}::int, "passingGrade"),
          "maxQuestionsAllowed" = COALESCE(${maxQuestionsAllowed}::int, "maxQuestionsAllowed"),
          "autoStart" = COALESCE(${autoStart}::boolean, "autoStart"),
          "questionLayout" = COALESCE(${questionLayout}::text, "questionLayout"),
          "questionOrder" = COALESCE(${questionOrder}::text, "questionOrder"),
          "hideQuestionNumber" = COALESCE(${hideQuestionNumber}::boolean, "hideQuestionNumber"),
          "shortAnswerCharLimit" = COALESCE(${shortAnswerCharLimit}::int, "shortAnswerCharLimit"),
          "essayCharLimit" = COALESCE(${essayCharLimit}::int, "essayCharLimit"),
          "updatedAt" = NOW()
        WHERE id = ${quizId} AND "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
      `;
      if (n === 0) return data({ error: "Quiz not found." }, { status: 404 });
    }
    return data({ success: true });
  }

  if (intent === "delete_quiz") {
    const id = formData.get("id") as string;
    const quiz = await prisma.quiz.findFirst({ where: { id, module: { courseId } }, select: { moduleId: true } });
    if (!quiz) return data({ error: "Quiz not found." }, { status: 404 });
    await prisma.$executeRaw`DELETE FROM "Quiz" WHERE id = ${id}`;
    await normalizeModuleOrder(quiz.moduleId);
    await recomputeCourseProgressForAllUsers(courseId);
    return data({ success: true });
  }

  // ── Questions ─────────────────────────────────────────────────────────────
  if (intent === "create_question") {
    const quizId = formData.get("quizId") as string;
    const questionType = (formData.get("questionType") as string) || "MULTIPLE_CHOICE";
    if (!isQuestionType(questionType)) return data({ error: "Invalid question type." }, { status: 400 });
    const title = (formData.get("title") as string)?.trim() || "New Question";
    const quizOk = quizId && (await prisma.quiz.count({ where: { id: quizId, module: { courseId } } })) > 0;
    if (!quizOk) return data({ error: "Quiz not found." }, { status: 404 });
    const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM "Question" WHERE "quizId" = ${quizId}
    `;
    const newId = randomUUID();
    // Question + its seeded True/False answers are one unit of work.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Question" (id, "quizId", "questionType", title, "order", points, "answerRequired", "allowMultiple", "randomizeAnswers", "createdAt")
        VALUES (${newId}, ${quizId}, ${questionType}, ${title}, ${Number(count)}, 1, false, false, false, NOW())
      `;
      if (questionType === "TRUE_FALSE") {
        await tx.$executeRaw`
          INSERT INTO "Answer" (id, "questionId", text, "isCorrect", "isOptional", "order")
          VALUES (${randomUUID()}, ${newId}, 'True', true, false, 0),
                 (${randomUUID()}, ${newId}, 'False', false, false, 1)
        `;
      }
    });
    return data({ success: true });
  }

  if (intent === "update_question") {
    const id = formData.get("id") as string;
    if (!(await questionInCourse(id))) return data({ error: "Question not found." }, { status: 404 });
    const title = (formData.get("title") as string)?.trim() || "";
    const description = (formData.get("description") as string)?.trim() || null;
    const questionType = (formData.get("questionType") as string) || "MULTIPLE_CHOICE";
    if (!isQuestionType(questionType)) return data({ error: "Invalid question type." }, { status: 400 });
    const parsedPoints = parseInt(String(formData.get("points") ?? ""), 10);
    const points = Number.isInteger(parsedPoints) ? Math.min(1000, Math.max(0, parsedPoints)) : 1;
    const answerRequired = formData.get("answerRequired") === "true";
    const allowMultiple = formData.get("allowMultiple") === "true";
    const randomizeAnswers = formData.get("randomizeAnswers") === "true";
    // Switching "Multiple Correct Answer" off must leave a single correct
    // option, otherwise the student side would accept any of the leftovers.
    if (questionType === "MULTIPLE_CHOICE" && !allowMultiple) {
      await prisma.$executeRaw`
        UPDATE "Answer" SET "isCorrect" = false
        WHERE "questionId" = ${id} AND "isCorrect" = true
          AND id <> (SELECT id FROM "Answer" WHERE "questionId" = ${id} AND "isCorrect" = true ORDER BY "order", id LIMIT 1)
      `;
    }
    await prisma.$executeRaw`
      UPDATE "Question" SET
        title = ${title},
        description = ${description},
        "questionType" = ${questionType},
        points = ${points},
        "answerRequired" = ${answerRequired},
        "allowMultiple" = ${allowMultiple},
        "randomizeAnswers" = ${randomizeAnswers}
      WHERE id = ${id}
    `;
    return data({ success: true });
  }

  if (intent === "delete_question") {
    const id = formData.get("id") as string;
    if (!(await questionInCourse(id))) return data({ error: "Question not found." }, { status: 404 });
    // QuizAttemptAnswer.questionId is SET NULL by the FK, so past attempts keep their score.
    await prisma.$executeRaw`DELETE FROM "Question" WHERE id = ${id}`;
    return data({ success: true });
  }

  // ── Answers ───────────────────────────────────────────────────────────────
  if (intent === "create_answer") {
    const questionId = formData.get("questionId") as string;
    if (!(await questionInCourse(questionId))) return data({ error: "Question not found." }, { status: 404 });
    const text = (formData.get("text") as string)?.trim() || "Option";
    const matchText = (formData.get("matchText") as string)?.trim() || null;
    const videoUrl = (formData.get("videoUrl") as string)?.trim() || null;
    const imageUrl = (formData.get("imageUrl") as string)?.trim() || null;
    const isOptional = formData.get("isOptional") === "true";
    const newId = randomUUID();
    // Answers are entered in their intended order; ORDERING questions grade against it.
    await prisma.$executeRaw`
      INSERT INTO "Answer" (id, "questionId", text, "isCorrect", "videoUrl", "imageUrl", "isOptional", "matchText", "order")
      VALUES (${newId}, ${questionId}, ${text}, false, ${videoUrl}, ${imageUrl}, ${isOptional}, ${matchText},
        (SELECT COALESCE(MAX("order"), -1) + 1 FROM "Answer" WHERE "questionId" = ${questionId}))
    `;
    return data({ success: true });
  }

  if (intent === "update_answer") {
    const id = formData.get("id") as string;
    if (!(await answerInCourse(id))) return data({ error: "Answer not found." }, { status: 404 });
    const text = (formData.get("text") as string)?.trim() || "";
    const matchText = (formData.get("matchText") as string)?.trim() || null;
    const videoUrl = (formData.get("videoUrl") as string)?.trim() || null;
    const imageUrl = (formData.get("imageUrl") as string)?.trim() || null;
    const isOptional = formData.get("isOptional") === "true";
    await prisma.$executeRaw`
      UPDATE "Answer" SET text = ${text}, "matchText" = ${matchText}, "videoUrl" = ${videoUrl},
        "imageUrl" = ${imageUrl}, "isOptional" = ${isOptional}
      WHERE id = ${id}
    `;
    return data({ success: true });
  }

  // ── True/False: select correct answer ──────────────────────────────────────
  if (intent === "set_tf_correct") {
    const questionId = formData.get("questionId") as string;
    const label = formData.get("label") as string; // "True" or "False"
    const otherLabel = label === "True" ? "False" : "True";

    // Step 1: clear correct flag on all answers for this question
    await prisma.$executeRaw`UPDATE "Answer" SET "isCorrect" = false WHERE "questionId" = ${questionId}`;

    // Step 2: find chosen label by text (server-side, not relying on client ID)
    const chosen = await prisma.$queryRaw<any[]>`
      SELECT id FROM "Answer" WHERE "questionId" = ${questionId} AND text = ${label}
    `;
    if (chosen.length > 0) {
      await prisma.$executeRaw`UPDATE "Answer" SET "isCorrect" = true WHERE id = ${chosen[0].id}`;
    } else {
      const newId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "Answer" (id, "questionId", text, "isCorrect", "isOptional")
        VALUES (${newId}, ${questionId}, ${label}, true, false)
      `;
    }

    // Step 3: ensure the other option also exists (so both are always visible)
    const other = await prisma.$queryRaw<any[]>`
      SELECT id FROM "Answer" WHERE "questionId" = ${questionId} AND text = ${otherLabel}
    `;
    if (other.length === 0) {
      const otherId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "Answer" (id, "questionId", text, "isCorrect", "isOptional")
        VALUES (${otherId}, ${questionId}, ${otherLabel}, false, false)
      `;
    }

    return data({ success: true });
  }

  if (intent === "toggle_answer_correct") {
    const id = formData.get("id") as string;
    if (!(await answerInCourse(id))) return data({ error: "Answer not found." }, { status: 404 });
    const current = formData.get("current") === "true";

    // Single-choice questions (everything except FILL_BLANK and a
    // MULTIPLE_CHOICE with "Multiple Correct Answer" on) keep exactly one
    // correct answer - marking a second one clears the first.
    if (!current) {
      const qInfo = await prisma.$queryRaw<any[]>`
        SELECT q."questionType", q."allowMultiple", a."questionId"
        FROM "Answer" a
        JOIN "Question" q ON q.id = a."questionId"
        WHERE a.id = ${id}
      `;
      const qType = qInfo[0]?.questionType;
      const questionId = qInfo[0]?.questionId;
      const multi = qType === "FILL_BLANK" || (qType === "MULTIPLE_CHOICE" && !!qInfo[0]?.allowMultiple);
      if (!multi && questionId) {
        await prisma.$executeRaw`
          UPDATE "Answer" SET "isCorrect" = false WHERE "questionId" = ${questionId}
        `;
      }
    }

    await prisma.$executeRaw`
      UPDATE "Answer" SET "isCorrect" = ${!current} WHERE id = ${id}
    `;
    return data({ success: true });
  }

  // Move an answer one step up/down; renumbers the whole question so legacy
  // rows (all order = 0) become a proper 0..n-1 sequence and gradable.
  if (intent === "move_answer") {
    const id = formData.get("id") as string;
    const dir = formData.get("direction") === "up" ? -1 : 1;
    if (!(await answerInCourse(id))) return data({ error: "Answer not found." }, { status: 404 });
    const me = await prisma.answer.findUnique({ where: { id }, select: { questionId: true } });
    if (!me) return data({ error: "Answer not found." }, { status: 404 });
    const list = await prisma.answer.findMany({
      where: { questionId: me.questionId },
      select: { id: true },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });
    const idx = list.findIndex((a) => a.id === id);
    const to = idx + dir;
    if (idx === -1) return data({ error: "Answer not found." }, { status: 404 });
    if (to >= 0 && to < list.length) [list[idx], list[to]] = [list[to], list[idx]];
    await prisma.$transaction(
      list.map((a, i) => prisma.answer.update({ where: { id: a.id }, data: { order: i } })),
    );
    return data({ success: true });
  }

  // ── Resources ─────────────────────────────────────────────────────────────
  if (intent === "create_resource" || intent === "update_resource") {
    const id = formData.get("id") as string;
    const title = String(formData.get("title") || "").trim();
    const description = String(formData.get("description") || "").trim() || null;
    const kind = String(formData.get("kind") || "FILE") === "LINK" ? "LINK" : "FILE";
    const url = String(formData.get("url") || "").trim();
    const lessonIdRaw = String(formData.get("lessonId") || "").trim();
    const fileName = String(formData.get("fileName") || "").trim() || null;
    const fileType = String(formData.get("fileType") || "").trim() || null;
    const sizeRaw = parseInt(String(formData.get("fileSize") || ""), 10);
    const fileSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;

    if (!title) return data({ error: "Give the resource a title." }, { status: 400 });
    if (!url) {
      return data(
        { error: kind === "LINK" ? "Paste a link." : "Choose a file to upload." },
        { status: 400 },
      );
    }
    if (kind === "LINK" && !/^https?:\/\//i.test(url)) {
      return data({ error: "Links must start with http:// or https://" }, { status: 400 });
    }

    // A lesson may only be picked from THIS course.
    let lessonId: string | null = null;
    if (lessonIdRaw) {
      const owns = await prisma.lesson.count({ where: { id: lessonIdRaw, module: { courseId } } });
      if (owns === 0) return data({ error: "That lesson is not part of this course." }, { status: 400 });
      lessonId = lessonIdRaw;
    }

    if (intent === "create_resource") {
      const last = await prisma.courseResource.findFirst({
        where: { courseId },
        orderBy: { order: "desc" },
        select: { order: true },
      });
      await prisma.courseResource.create({
        data: {
          courseId, lessonId, title, description, kind, url,
          fileName, fileType, fileSize, order: (last?.order ?? -1) + 1,
        },
      });
    } else {
      // updateMany scopes the write to this course - an id from elsewhere is a no-op.
      const r = await prisma.courseResource.updateMany({
        where: { id, courseId },
        data: { lessonId, title, description, kind, url, fileName, fileType, fileSize },
      });
      if (r.count === 0) return data({ error: "Resource not found." }, { status: 404 });
    }
    return data({ success: true });
  }

  if (intent === "delete_resource") {
    const id = formData.get("id") as string;
    const r = await prisma.courseResource.deleteMany({ where: { id, courseId } });
    if (r.count === 0) return data({ error: "Resource not found." }, { status: 404 });
    return data({ success: true });
  }

  if (intent === "toggle_resource") {
    const id = formData.get("id") as string;
    const row = await prisma.courseResource.findFirst({
      where: { id, courseId },
      select: { isActive: true },
    });
    if (!row) return data({ error: "Resource not found." }, { status: 404 });
    await prisma.courseResource.updateMany({
      where: { id, courseId },
      data: { isActive: !row.isActive },
    });
    return data({ success: true });
  }

  if (intent === "move_resource") {
    const id = formData.get("id") as string;
    const dir = formData.get("direction") === "up" ? -1 : 1;
    const list = await prisma.courseResource.findMany({
      where: { courseId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return data({ error: "Resource not found." }, { status: 404 });
    const to = idx + dir;
    if (to >= 0 && to < list.length) [list[idx], list[to]] = [list[to], list[idx]];
    await prisma.$transaction(
      list.map((r, i) => prisma.courseResource.update({ where: { id: r.id }, data: { order: i } })),
    );
    return data({ success: true });
  }

  // ── Glossary ──────────────────────────────────────────────────────────────
  if (intent === "create_term" || intent === "update_term") {
    const id = formData.get("id") as string;
    const term = String(formData.get("term") || "").trim();
    const definition = String(formData.get("definition") || "").trim();
    if (!term || !definition) {
      return data({ error: "A glossary entry needs both a term and a definition." }, { status: 400 });
    }
    if (intent === "create_term") {
      const dupe = await prisma.glossaryTerm.findFirst({
        where: { courseId, term: { equals: term, mode: "insensitive" } },
        select: { id: true },
      });
      if (dupe) return data({ error: `"${term}" is already in this glossary.` }, { status: 409 });
      await prisma.glossaryTerm.create({ data: { courseId, term, definition } });
    } else {
      const r = await prisma.glossaryTerm.updateMany({
        where: { id, courseId },
        data: { term, definition },
      });
      if (r.count === 0) return data({ error: "Term not found." }, { status: 404 });
    }
    return data({ success: true });
  }

  if (intent === "delete_term") {
    const id = formData.get("id") as string;
    const r = await prisma.glossaryTerm.deleteMany({ where: { id, courseId } });
    if (r.count === 0) return data({ error: "Term not found." }, { status: 404 });
    return data({ success: true });
  }

  if (intent === "delete_answer") {
    const id = formData.get("id") as string;
    if (!(await answerInCourse(id))) return data({ error: "Answer not found." }, { status: 404 });
    await prisma.$executeRaw`DELETE FROM "Answer" WHERE id = ${id}`;
    return data({ success: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ── Lesson type config ────────────────────────────────────────────────────────

const lessonTypeConfig: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  VIDEO:     { icon: Video,       label: "Video",     color: "text-blue-600 bg-blue-50" },
  STORYLINE: { icon: MonitorPlay, label: "Storyline", color: "text-purple-600 bg-purple-50" },
  TEXT:      { icon: FileText,    label: "Text",      color: "text-gray-600 bg-gray-100" },
  DOWNLOAD:  { icon: Download,    label: "Download",  color: "text-amber-600 bg-amber-50" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function secondsToHMS(seconds: number | null) {
  if (!seconds) return { h: 0, m: 0, s: 0 };
  return { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60), s: seconds % 60 };
}

// ── Lesson Modal (Tutor LMS 2-column style) ───────────────────────────────────

function LessonModal({
  moduleId,
  moduleName,
  lesson,
  onClose,
  fetcher,
}: {
  moduleId: string;
  moduleName: string;
  lesson?: any;
  onClose: () => void;
  fetcher: any;
}) {
  const [lessonType, setLessonType] = useState(lesson?.lessonType || "VIDEO");
  const dur = secondsToHMS(lesson?.duration);
  // Own fetcher: the shared page fetcher's stale `data` would close this
  // modal (or hide its error) based on some earlier, unrelated submission.
  const lessonFetcher = useFetcher<{ success?: boolean; error?: string }>();
  useEffect(() => {
    if (lessonFetcher.state === "idle" && lessonFetcher.data?.success) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonFetcher.state, lessonFetcher.data]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col border border-gray-100">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 shrink-0">
          <FileText size={16} className="text-gray-500" />
          <span className="font-semibold text-gray-900 text-sm">Lesson</span>
          <span className="text-gray-400 text-sm">|</span>
          <span className="text-gray-500 text-sm">Topic: {moduleName}</span>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <lessonFetcher.Form
          method="post"
          className="flex flex-1 flex-col overflow-hidden"
        >
          {lessonFetcher.data?.error && (
            <div className="mx-6 mt-4 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
              <AlertCircle size={14} className="shrink-0" /> {lessonFetcher.data.error}
            </div>
          )}
          <input type="hidden" name="intent" value={lesson ? "update_lesson" : "create_lesson"} />
          <input type="hidden" name="moduleId" value={moduleId} />
          {lesson && <input type="hidden" name="lessonId" value={lesson.id} />}
          <input type="hidden" name="lessonType" value={lessonType} />

          {/* Main content row */}
          <div className="flex flex-1 overflow-hidden min-h-0">

          {/* Left: content */}
          <div className="flex-1 p-6 space-y-5 overflow-y-auto border-r border-gray-100">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="title"
                defaultValue={lesson?.title || ""}
                required
                autoFocus
                placeholder="Enter Lesson Name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* Lesson type selector */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2 uppercase tracking-wide">
                Lesson Type
              </label>
              <div className="flex gap-2 flex-wrap">
                {Object.entries(lessonTypeConfig).map(([type, { icon: Icon, label }]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setLessonType(type)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                      lessonType === type
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Content</label>
              <textarea
                name="content"
                defaultValue={lesson?.content || ""}
                rows={8}
                placeholder="Enter lesson content…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
              />
            </div>
          </div>

          {/* Right: media */}
          <div className="w-72 shrink-0 p-6 space-y-5 overflow-y-auto">

            {/* Featured Image */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <Image size={13} /> Featured Image
              </label>
              <ImageUpload name="thumbnailUrl" defaultValue={lesson?.thumbnailUrl || ""} label="Upload Thumbnail" />
            </div>

            {/* Video */}
            {(lessonType === "VIDEO") && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                    <Play size={13} /> Video URL
                  </label>
                  <input
                    type="text"
                    name="videoUrl"
                    defaultValue={lesson?.videoUrl || ""}
                    placeholder="YouTube, Vimeo, or .mp4 URL"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">YouTube, Vimeo, MP4, WebM</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                    <Globe size={13} /> iFrame Embed <span className="text-[10px] font-normal text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded ml-1">overrides Video URL</span>
                  </label>
                  <textarea
                    name="iframeEmbed"
                    defaultValue={lesson?.iframeEmbed || ""}
                    rows={3}
                    placeholder={'<iframe src="/wp-content/..." width="100%" height="100%"></iframe>'}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono resize-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Paste a full &lt;iframe&gt; tag — takes priority over Video URL above</p>
                </div>
              </div>
            )}

            {/* Storyline */}
            {lessonType === "STORYLINE" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                  <MonitorPlay size={13} /> Storyline Embed URL
                </label>
                <input
                  type="url"
                  name="embedUrl"
                  defaultValue={lesson?.embedUrl || ""}
                  placeholder="https://…/story_html5.html"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Download */}
            {lessonType === "DOWNLOAD" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                  <Download size={13} /> Resource URL
                </label>
                <input
                  type="url"
                  name="resourceUrl"
                  defaultValue={lesson?.resourceUrl || ""}
                  placeholder="https://…/file.pdf"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Video Playback Time */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Video Playback Time
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { name: "durationH", label: "hour", defaultValue: dur.h },
                  { name: "durationM", label: "min", defaultValue: dur.m },
                  { name: "durationS", label: "sec", defaultValue: dur.s },
                ].map(({ name, label, defaultValue }) => (
                  <div key={name}>
                    <input
                      type="number"
                      name={name}
                      defaultValue={defaultValue}
                      min={0}
                      className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-[10px] text-gray-400 text-center mt-1">{label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Exercise Files */}
            {lessonType !== "DOWNLOAD" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Exercise Files
                </label>
                <input
                  type="url"
                  name="resourceUrl"
                  defaultValue={lesson?.resourceUrl || ""}
                  placeholder="https://…/exercise.zip"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            )}
          </div>
          </div>{/* end main content row */}

          {/* Footer — normal flow, always visible at bottom */}
          <div className="flex justify-end gap-3 px-6 py-3 bg-white border-t border-gray-200 rounded-b-2xl shrink-0">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={lessonFetcher.state !== "idle"}
              className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
            >
              {lessonFetcher.state !== "idle" ? "Saving…" : lesson ? "Update Lesson" : "Add Lesson"}
            </button>
          </div>
        </lessonFetcher.Form>
      </div>
    </div>
  );
}

// ── Quiz Modal (Tutor LMS style with 2 tabs) ──────────────────────────────────

const QUESTION_TYPE_DEFS = [
  { value: "TRUE_FALSE",      label: "True/False",         color: "bg-blue-100 text-blue-700",    icon: "⊙" },
  { value: "MULTIPLE_CHOICE", label: "Multiple Choice",    color: "bg-purple-100 text-purple-700", icon: "☑" },
  { value: "ESSAY",           label: "Open Ended/Essay",   color: "bg-red-100 text-red-600",       icon: "✎" },
  { value: "FILL_BLANK",      label: "Fill in the Blanks", color: "bg-orange-100 text-orange-600", icon: "⧗" },
  { value: "SHORT_ANSWER",    label: "Short Answer",       color: "bg-amber-100 text-amber-700",   icon: "#" },
  { value: "MATCHING",        label: "Matching",           color: "bg-stone-100 text-stone-600",   icon: "⊞" },
  { value: "IMAGE_ANSWERING", label: "Image Answering",    color: "bg-green-100 text-green-700",   icon: "⊡" },
  { value: "VIDEO_ANSWERING", label: "Video Answering",    color: "bg-cyan-100 text-cyan-700",     icon: "▶" },
  { value: "ORDERING",        label: "Ordering",           color: "bg-indigo-100 text-indigo-700", icon: "↕" },
];

const TYPES_WITH_ANSWERS = new Set(["MULTIPLE_CHOICE", "TRUE_FALSE", "FILL_BLANK", "MATCHING", "IMAGE_ANSWERING", "VIDEO_ANSWERING", "ORDERING"]);

function TrueFalseAnswerEditor({ answers, questionId }: { answers: any[]; questionId: string }) {
  const [videoEdit, setVideoEdit] = useState<"True" | "False" | null>(null);
  const tfFetcher    = useFetcher();
  const videoFetcher = useFetcher();

  const trueAns  = answers.find((a: any) => a.text === "True")  ?? null;
  const falseAns = answers.find((a: any) => a.text === "False") ?? null;

  // Optimistically reflect a pending selection so the UI feels instant
  const pendingLabel = tfFetcher.state !== "idle"
    ? (tfFetcher.formData?.get("label") as "True" | "False" | null)
    : null;

  const serverCorrect = trueAns?.isCorrect ? "True" : falseAns?.isCorrect ? "False" : null;
  const correctLabel  = pendingLabel ?? serverCorrect;

  function selectCorrect(label: "True" | "False") {
    const fd = new FormData();
    fd.append("intent", "set_tf_correct");
    fd.append("questionId", questionId);
    fd.append("label", label);
    tfFetcher.submit(fd, { method: "post" });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-gray-700">Correct Answer</label>
        <span className="text-[11px] text-gray-400">Select the correct option</span>
      </div>

      {/* Two big selector buttons */}
      <div className="grid grid-cols-2 gap-3">
        {(["True", "False"] as const).map((label) => {
          const isSelected = correctLabel === label;
          const ans = label === "True" ? trueAns : falseAns;
          return (
            <div key={label} className={`rounded-xl border-2 overflow-hidden transition-all ${isSelected ? "border-green-500 shadow-sm" : "border-gray-200"}`}>
              <button
                type="button"
                onClick={() => selectCorrect(label)}
                className={`w-full flex items-center gap-3 px-4 py-4 transition-colors text-left ${
                  isSelected ? "bg-green-50 hover:bg-green-100" : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  isSelected ? "bg-green-500 border-green-500" : "border-gray-300"
                }`}>
                  {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                </div>
                <span className={`font-bold text-base ${isSelected ? "text-green-700" : "text-gray-700"}`}>
                  {label}
                </span>
                {isSelected && (
                  <span className="ml-auto text-[10px] font-semibold text-green-600 bg-green-100 px-2 py-0.5 rounded-full">
                    Correct
                  </span>
                )}
              </button>
              {/* Video URL toggle */}
              <div className="border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setVideoEdit(videoEdit === label ? null : label)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  {ans?.videoUrl
                    ? <><span className="text-blue-500">▶</span> Video attached</>
                    : <><span>+</span> Add video</>
                  }
                  {videoEdit === label ? <ChevronUp size={11} className="ml-auto" /> : <ChevronDown size={11} className="ml-auto" />}
                </button>
                {videoEdit === label && ans && (
                  <videoFetcher.Form method="post" className="px-4 pb-3 space-y-2 bg-gray-50">
                    <input type="hidden" name="intent" value="update_answer" />
                    <input type="hidden" name="id" value={ans.id} />
                    <input type="hidden" name="text" value={ans.text} />
                    <input type="hidden" name="matchText" value="" />
                    <input type="hidden" name="imageUrl" value={ans.imageUrl || ""} />
                    <input
                      name="videoUrl"
                      type="url"
                      defaultValue={ans.videoUrl || ""}
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500"
                      placeholder="YouTube, Vimeo, or .mp4"
                    />
                    <div className="flex justify-end">
                      <button type="submit" onClick={() => setVideoEdit(null)} className="px-3 py-1 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                        {videoFetcher.state !== "idle" ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </videoFetcher.Form>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnswerRow({ ans, questionType, questionId }: { ans: any; questionType: string; questionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const toggleFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const editFetcher   = useFetcher();
  const moveFetcher   = useFetcher();

  // Optimistic correct state
  const pendingCorrect = toggleFetcher.state !== "idle"
    ? toggleFetcher.formData?.get("current") !== "true"
    : null;
  const isCorrect = pendingCorrect !== null ? pendingCorrect : ans.isCorrect;

  if (deleteFetcher.state !== "idle") return null; // optimistically remove on delete

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-white">
        {/* Correct toggle */}
        {questionType !== "ORDERING" && (
          <toggleFetcher.Form method="post" className="shrink-0">
            <input type="hidden" name="intent" value="toggle_answer_correct" />
            <input type="hidden" name="id" value={ans.id} />
            <input type="hidden" name="current" value={String(ans.isCorrect)} />
            <button
              type="submit"
              title={isCorrect
                ? (questionType === "FILL_BLANK" ? "Remove accepted answer" : "Mark incorrect")
                : (questionType === "FILL_BLANK" ? "Mark as accepted answer" : "Mark correct")}
              className={`w-4 h-4 rounded border-2 shrink-0 transition-colors ${isCorrect ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-green-400"}`}
            />
          </toggleFetcher.Form>
        )}

        <span className="flex-1 text-sm text-gray-800 truncate">
          {questionType === "MATCHING" ? (ans.text || "—") + " → " + (ans.matchText || "?") : (ans.text || "—")}
        </span>

        {ans.isOptional && <span className="text-[10px] text-gray-400 italic shrink-0">optional</span>}
        {ans.videoUrl  && <span className="text-[10px] text-blue-500 shrink-0">▶ video</span>}
        {ans.imageUrl  && <span className="text-[10px] text-green-500 shrink-0">🖼</span>}

        {questionType === "ORDERING" && (
          <moveFetcher.Form method="post" className="flex items-center shrink-0">
            <input type="hidden" name="intent" value="move_answer" />
            <input type="hidden" name="id" value={ans.id} />
            <button type="submit" name="direction" value="up" title="Move up" className="text-gray-400 hover:text-gray-700 p-0.5"><ChevronUp size={13} /></button>
            <button type="submit" name="direction" value="down" title="Move down" className="text-gray-400 hover:text-gray-700 p-0.5"><ChevronDown size={13} /></button>
          </moveFetcher.Form>
        )}

        <button type="button" onClick={() => setExpanded(v => !v)} className="text-gray-400 hover:text-gray-600 p-0.5 shrink-0">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        <deleteFetcher.Form method="post" className="shrink-0">
          <input type="hidden" name="intent" value="delete_answer" />
          <input type="hidden" name="id" value={ans.id} />
          <button type="submit" className="text-red-400 hover:text-red-600 p-0.5">
            <X size={12} />
          </button>
        </deleteFetcher.Form>
      </div>

      {expanded && (
        <editFetcher.Form method="post" className="px-3 pb-3 pt-2 bg-gray-50 border-t border-gray-100 space-y-2">
          <input type="hidden" name="intent" value="update_answer" />
          <input type="hidden" name="id" value={ans.id} />

          {questionType === "MATCHING" ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-gray-500 mb-0.5">Left</label>
                <input name="text" defaultValue={ans.text || ""} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500" placeholder="Left item" />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 mb-0.5">Right (match)</label>
                <input name="matchText" defaultValue={ans.matchText || ""} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500" placeholder="Right item" />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[11px] text-gray-500 mb-0.5">Content</label>
              <input name="text" defaultValue={ans.text || ""} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500" placeholder="Answer text" />
              <input type="hidden" name="matchText" value="" />
            </div>
          )}

          {questionType === "IMAGE_ANSWERING" && (
            <div>
              <label className="block text-[11px] text-gray-500 mb-0.5">Image URL</label>
              <input name="imageUrl" type="url" defaultValue={ans.imageUrl || ""} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500" placeholder="https://…/image.jpg" />
            </div>
          )}
          {questionType !== "IMAGE_ANSWERING" && <input type="hidden" name="imageUrl" value={ans.imageUrl || ""} />}

          <div>
            <label className="block text-[11px] text-gray-500 mb-0.5">
              {questionType === "VIDEO_ANSWERING" ? <>Video URL <span className="text-red-400">*</span></> : "Video URL (optional)"}
            </label>
            <input name="videoUrl" type="url" defaultValue={ans.videoUrl || ""} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500" placeholder="YouTube, Vimeo, or .mp4" />
          </div>

          <div className="flex items-center gap-2">
            <input type="checkbox" name="isOptional" value="true" id={`opt-${ans.id}`} defaultChecked={ans.isOptional} className="rounded border-gray-300" />
            <label htmlFor={`opt-${ans.id}`} className="text-xs text-gray-600 cursor-pointer">Optional answer</label>
          </div>

          <div className="flex justify-end pt-1">
            <button type="submit" onClick={() => setExpanded(false)} className="px-3 py-1 text-xs text-white bg-blue-600 rounded hover:bg-blue-700">
              {editFetcher.state !== "idle" ? "Saving…" : "Save"}
            </button>
          </div>
        </editFetcher.Form>
      )}
    </div>
  );
}

function AddAnswerRow({ questionId, questionType }: { questionId: string; questionType: string }) {
  const addFetcher = useFetcher<{ success?: boolean }>();
  const formRef = useRef<HTMLFormElement>(null);
  // Clear the inputs once the option is saved - otherwise a second click on
  // "Add" re-submits the same text and creates a duplicate.
  useEffect(() => {
    if (addFetcher.state === "idle" && addFetcher.data?.success) formRef.current?.reset();
  }, [addFetcher.state, addFetcher.data]);
  return (
    <addFetcher.Form ref={formRef} method="post" className="space-y-1.5 mt-1">
      <input type="hidden" name="intent" value="create_answer" />
      <input type="hidden" name="questionId" value={questionId} />
      <div className="flex gap-2">
        {questionType === "MATCHING" ? (
          <>
            <input name="text" required placeholder="Left item" className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500" />
            <input name="matchText" placeholder="Right item" className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500" />
          </>
        ) : (
          <input name="text" placeholder={questionType === "VIDEO_ANSWERING" ? "Caption (optional)…" : "Add answer option…"} className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500" />
        )}
        <button type="submit" disabled={addFetcher.state !== "idle"} className="px-3 py-1.5 text-xs text-white bg-gray-700 rounded-lg hover:bg-gray-800 disabled:opacity-60 shrink-0">
          {addFetcher.state !== "idle" ? "Adding…" : "Add"}
        </button>
      </div>
      {questionType === "VIDEO_ANSWERING" && (
        <input name="videoUrl" type="url" required placeholder="Video URL (YouTube, Vimeo, or .mp4)…" className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-blue-500" />
      )}
    </addFetcher.Form>
  );
}

function QuestionConditionsPanel({ question, fetcher }: { question: any; fetcher: any }) {
  const [answerRequired, setAnswerRequired] = useState<boolean>(question.answerRequired ?? false);
  const [allowMultiple, setAllowMultiple] = useState<boolean>(question.allowMultiple ?? false);
  const [randomizeAnswers, setRandomizeAnswers] = useState<boolean>(question.randomizeAnswers ?? false);
  const [points, setPoints] = useState<string>(String(question.points ?? 1));

  function save(overrides?: Partial<{ answerRequired: boolean; allowMultiple: boolean; randomizeAnswers: boolean; points: string }>) {
    const vals = { answerRequired, allowMultiple, randomizeAnswers, points, ...overrides };
    const fd = new FormData();
    fd.append("intent", "update_question");
    fd.append("id", question.id);
    fd.append("title", question.title ?? "");
    fd.append("description", question.description ?? "");
    fd.append("questionType", question.questionType);
    fd.append("points", String(Math.max(0, parseInt(String(vals.points), 10) || 0)));
    fd.append("answerRequired", String(vals.answerRequired));
    fd.append("allowMultiple", String(vals.allowMultiple));
    fd.append("randomizeAnswers", String(vals.randomizeAnswers));
    fetcher.submit(fd, { method: "post" });
  }

  function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
      <div className="flex items-center justify-between py-1.5">
        <span className="text-xs text-gray-700">{label}</span>
        <button
          type="button"
          onClick={() => { onChange(!checked); save({ [label === "Answer Required" ? "answerRequired" : label === "Multiple Correct Answer" ? "allowMultiple" : "randomizeAnswers"]: !checked }); }}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? "bg-blue-600" : "bg-gray-200"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conditions</p>

      <Toggle label="Answer Required" checked={answerRequired} onChange={(v) => { setAnswerRequired(v); }} />

      {question.questionType === "MULTIPLE_CHOICE" && (
        <>
          <Toggle label="Multiple Correct Answer" checked={allowMultiple} onChange={(v) => { setAllowMultiple(v); }} />
          <Toggle label="Randomize Choice" checked={randomizeAnswers} onChange={(v) => { setRandomizeAnswers(v); }} />
        </>
      )}

      <div className="pt-1">
        <label className="block text-xs text-gray-700 mb-1.5">Point For This Question</label>
        <input
          type="number"
          value={points}
          min={0}
          onChange={(e) => setPoints(e.target.value)}
          onBlur={() => save()}
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-center focus:outline-none focus:border-blue-500"
        />
      </div>
    </div>
  );
}

function QuizModal({
  moduleId,
  moduleName,
  quiz,
  onClose,
  fetcher,
}: {
  moduleId: string;
  moduleName: string;
  quiz?: any;
  onClose: () => void;
  fetcher: any;
}) {
  const [activeTab, setActiveTab] = useState<"details" | "settings">("details");
  const [selectedQuestion, setSelectedQuestion] = useState<any | null>(null);
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [hideQuizTime, setHideQuizTime] = useState<boolean>(!!quiz?.hideQuizTime);
  // Dedicated fetcher for the quiz Details/Settings forms so a stale success
  // from some other submission can't satisfy the "close after save" guard.
  const quizFetcher = useFetcher<{ success?: boolean; error?: string }>();

  // Close modal only after THIS save succeeded
  useEffect(() => {
    if (pendingClose && quizFetcher.state === "idle" && quizFetcher.data?.success) {
      setPendingClose(false);
      onClose();
    }
    if (pendingClose && quizFetcher.state === "idle" && quizFetcher.data?.error) {
      setPendingClose(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizFetcher.state, quizFetcher.data, pendingClose]);

  const quizError = quizFetcher.state === "idle" ? quizFetcher.data?.error : undefined;

  // When selectedQuestion updates from fetcher reload, keep it in sync
  const questions: any[] = quiz?.questions ?? [];
  const syncedQuestion = selectedQuestion
    ? (questions.find((q: any) => q.id === selectedQuestion.id) ?? selectedQuestion)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col border border-gray-100" style={{ height: "calc(100vh - 32px)" }}>
        {/* Header */}
        <div className="flex items-center gap-4 px-6 py-3.5 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle size={16} className="text-gray-500" />
            <span className="font-semibold text-gray-900 text-sm">Quiz</span>
            <span className="text-gray-400 text-sm">|</span>
            <span className="text-gray-500 text-sm">Topic: {moduleName}</span>
          </div>
          <div className="flex gap-1 ml-6">
            {(["details", "settings"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {tab === "details" ? "Question Details" : "Settings"}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {activeTab === "details" && (
          <div className="flex flex-1 overflow-hidden min-h-0">
            {/* Left: quiz title + question list */}
            <div className="w-72 shrink-0 border-r border-gray-100 flex flex-col min-h-0">
              <quizFetcher.Form method="post" className="p-4 space-y-3 border-b border-gray-100 shrink-0">
                <input type="hidden" name="intent" value={quiz ? "update_quiz" : "create_quiz"} />
                <input type="hidden" name="moduleId" value={moduleId} />
                {quiz && <input type="hidden" name="quizId" value={quiz.id} />}
                {quizError && (
                  <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <AlertCircle size={12} className="shrink-0" /> {quizError}
                  </div>
                )}
                <textarea name="title" defaultValue={quiz?.title || ""} placeholder="Add quiz title" rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 resize-none" />
                <textarea name="summary" defaultValue={quiz?.summary || ""} placeholder="Add a summary" rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 resize-none" />
                <div className="flex gap-2">
                  <button type="button" onClick={onClose} className="flex-1 px-3 py-1.5 text-xs text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={quizFetcher.state !== "idle"}
                    className="flex-1 px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
                    onClick={() => setPendingClose(true)}>{quizFetcher.state !== "idle" ? "Saving…" : "Ok"}</button>
                </div>
              </quizFetcher.Form>

              {/* Questions header + type picker — outside scroll area so dropdown isn't clipped */}
              <div className="px-3 pt-3 pb-1 shrink-0 relative">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Questions</span>
                  {quiz && (
                    <button
                      type="button"
                      onClick={() => setShowTypePicker(v => !v)}
                      className="w-7 h-7 flex items-center justify-center bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                {showTypePicker && quiz && (
                  <div className="absolute right-3 top-10 z-50 bg-white rounded-xl shadow-2xl border border-gray-100 w-64 overflow-y-auto" style={{ maxHeight: "min(440px, calc(92vh - 240px))" }}>
                    <p className="px-4 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100 sticky top-0 bg-white">Select Question Type</p>
                    {QUESTION_TYPE_DEFS.map(({ value, label, color, icon }) => (
                      <fetcher.Form key={value} method="post" onSubmit={() => setShowTypePicker(false)}>
                        <input type="hidden" name="intent" value="create_question" />
                        <input type="hidden" name="quizId" value={quiz.id} />
                        <input type="hidden" name="questionType" value={value} />
                        <input type="hidden" name="title" value="New Question" />
                        <button
                          type="submit"
                          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                        >
                          <span className={`w-8 h-8 flex items-center justify-center rounded-lg text-sm font-bold ${color}`}>{icon}</span>
                          <span className="text-sm text-gray-800">{label}</span>
                        </button>
                      </fetcher.Form>
                    ))}
                  </div>
                )}
              </div>

              {/* Question list — scrollable */}
              <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
                {questions.length === 0 && (
                  <p className="text-xs text-gray-400 italic py-3 text-center">No questions added yet.</p>
                )}

                {questions.map((q: any, idx: number) => {
                  const typeDef = QUESTION_TYPE_DEFS.find(t => t.value === q.questionType);
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => { setSelectedQuestion(q); setShowTypePicker(false); }}
                      className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors flex items-start gap-2 ${
                        syncedQuestion?.id === q.id
                          ? "bg-blue-50 border border-blue-200 text-blue-700"
                          : "hover:bg-gray-50 border border-transparent text-gray-700"
                      }`}
                    >
                      {typeDef && (
                        <span className={`w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold shrink-0 mt-0.5 ${typeDef.color}`}>{typeDef.icon}</span>
                      )}
                      <div>
                        <span className="font-medium">{idx + 1}. {q.title || "Untitled"}</span>
                        <span className="block text-[10px] text-gray-400 mt-0.5">{typeDef?.label ?? q.questionType.replace(/_/g, " ")}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Center + Right: 3-column question editor */}
            <div className="flex flex-1 overflow-hidden min-h-0" onClick={() => setShowTypePicker(false)}>
              {syncedQuestion ? (
                <>
                  {/* Center: question editor */}
                  <div className="flex-1 p-6 overflow-y-auto min-h-0 space-y-5">
                    {/* Question number + title + description form */}
                    <fetcher.Form key={syncedQuestion.id} method="post" className="space-y-3">
                      <input type="hidden" name="intent" value="update_question" />
                      <input type="hidden" name="id" value={syncedQuestion.id} />
                      <input type="hidden" name="questionType" value={syncedQuestion.questionType} />
                      <input type="hidden" name="points" value={syncedQuestion.points ?? 1} />
                      <input type="hidden" name="answerRequired" value={String(syncedQuestion.answerRequired ?? false)} />
                      <input type="hidden" name="allowMultiple" value={String(syncedQuestion.allowMultiple ?? false)} />
                      <input type="hidden" name="randomizeAnswers" value={String(syncedQuestion.randomizeAnswers ?? false)} />

                      <div>
                        <p className="text-xs text-gray-400 mb-1 font-medium uppercase tracking-wide">
                          {(questions.indexOf(syncedQuestion) + 1) || ""}. Question
                        </p>
                        <input
                          type="text"
                          name="title"
                          defaultValue={syncedQuestion.title}
                          className="w-full text-lg font-semibold text-gray-900 border-0 border-b-2 border-gray-200 px-0 py-1 focus:outline-none focus:border-blue-500 bg-transparent"
                          placeholder="Enter your question…"
                        />
                      </div>
                      <textarea
                        name="description"
                        defaultValue={syncedQuestion.description || ""}
                        rows={2}
                        placeholder="Description (optional)"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-600 focus:outline-none focus:border-blue-400 resize-none bg-gray-50"
                      />
                      <div className="flex justify-end">
                        <button type="submit" disabled={fetcher.state === "submitting"}
                          className="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60">
                          {fetcher.state === "submitting" ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </fetcher.Form>

                    {/* Answers section */}
                    {syncedQuestion.questionType === "TRUE_FALSE" ? (
                      <TrueFalseAnswerEditor answers={syncedQuestion.answers || []} questionId={syncedQuestion.id} />
                    ) : TYPES_WITH_ANSWERS.has(syncedQuestion.questionType) && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-semibold text-gray-700">
                            {syncedQuestion.questionType === "MATCHING" ? "Match Pairs" :
                             syncedQuestion.questionType === "ORDERING" ? "Items (correct order)" :
                             syncedQuestion.questionType === "IMAGE_ANSWERING" ? "Answer Images" :
                             syncedQuestion.questionType === "VIDEO_ANSWERING" ? "Answer Videos" : "Answers"}
                          </label>
                          <span className="text-[11px] text-gray-400">
                            {syncedQuestion.questionType === "FILL_BLANK" ? "✓ = accepted" :
                             syncedQuestion.questionType !== "ORDERING" ? "✓ = correct" : ""}
                          </span>
                        </div>
                        <div className="space-y-2">
                          {syncedQuestion.questionType === "ORDERING" && (
                            (() => {
                              const orders = (syncedQuestion.answers || []).map((a: any) => Number(a.order));
                              const gradable = orders.length > 1 && new Set(orders).size === orders.length;
                              return gradable ? (
                                <p className="text-[11px] text-gray-500">Answers are shown in the correct order. Use the arrows to change it.</p>
                              ) : (
                                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                                  Correct order not set yet - use the arrows to arrange the answers. Until then this question goes to manual review.
                                </p>
                              );
                            })()
                          )}
                          {(syncedQuestion.answers || []).map((ans: any) => (
                            <AnswerRow key={ans.id} ans={ans} questionType={syncedQuestion.questionType} questionId={syncedQuestion.id} />
                          ))}
                          <AddAnswerRow questionId={syncedQuestion.id} questionType={syncedQuestion.questionType} />
                        </div>
                      </div>
                    )}

                    {/* Info for text-based types */}
                    {(syncedQuestion.questionType === "SHORT_ANSWER" || syncedQuestion.questionType === "ESSAY") && (
                      <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-4 py-3 border border-gray-100">
                        {syncedQuestion.questionType === "SHORT_ANSWER"
                          ? "Students type a short text response. No answer options needed."
                          : "Students write an essay response. No answer options needed."}
                      </p>
                    )}

                    {/* Delete */}
                    <fetcher.Form method="post" className="pt-2">
                      <input type="hidden" name="intent" value="delete_question" />
                      <input type="hidden" name="id" value={syncedQuestion.id} />
                      <button type="submit" onClick={() => setSelectedQuestion(null)}
                        className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-600">
                        <Trash2 size={12} /> Delete Question
                      </button>
                    </fetcher.Form>
                  </div>

                  {/* Right: conditions panel */}
                  <div className="w-52 shrink-0 border-l border-gray-100 p-4 overflow-y-auto space-y-5">
                    {/* Question Type badge */}
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Question Type</p>
                      {(() => {
                        const typeDef = QUESTION_TYPE_DEFS.find(t => t.value === syncedQuestion.questionType);
                        return typeDef ? (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${typeDef.color}`}>
                            <span>{typeDef.icon}</span> {typeDef.label}
                          </span>
                        ) : null;
                      })()}
                    </div>

                    {/* Conditions */}
                    <QuestionConditionsPanel key={syncedQuestion.id} question={syncedQuestion} fetcher={fetcher} />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-gray-400 p-6">
                  <div className="w-24 h-24 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                    <HelpCircle size={36} className="text-gray-300" />
                  </div>
                  <p className="font-medium text-gray-500">Create/Select a question to view details</p>
                  <p className="text-xs mt-1">Click + to choose a question type</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "settings" && (
          <div className="flex-1 overflow-y-auto min-h-0">
            <quizFetcher.Form method="post" className="p-6 space-y-6" onSubmit={() => setPendingClose(true)}>
              {quizError && (
                <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
                  <AlertCircle size={14} className="shrink-0" /> {quizError}
                </div>
              )}
              <input type="hidden" name="intent" value={quiz ? "update_quiz" : "create_quiz"} />
              <input type="hidden" name="moduleId" value={moduleId} />
              {quiz && <input type="hidden" name="quizId" value={quiz.id} />}

              {/* Basic Settings */}
              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-5 py-4 font-semibold text-sm text-gray-900"
                >
                  Basic Settings <ChevronDown size={16} className="text-gray-400" />
                </button>
                <div className="px-5 pb-5 space-y-4 border-t border-gray-200">
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Time Limit</label>
                      <div className="flex gap-2">
                        <input type="number" name="timeLimit" defaultValue={quiz?.timeLimit ?? 0} min={0} className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                        <span className="flex items-center text-sm text-gray-500 px-2">Minutes</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between pt-6">
                      <label className="text-sm font-medium text-gray-700">Hide Quiz Time</label>
                      <input type="hidden" name="hideQuizTime" value={hideQuizTime ? "true" : "false"} />
                      <button
                        type="button"
                        role="switch"
                        aria-checked={hideQuizTime}
                        onClick={() => setHideQuizTime((v) => !v)}
                        className={`relative w-10 h-5 rounded-full transition-colors ${hideQuizTime ? "bg-blue-600" : "bg-gray-200"}`}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${hideQuizTime ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Feedback Mode</label>
                    <select name="feedbackMode" defaultValue={quiz?.feedbackMode || "RETRY"} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
                      <option value="RETRY">Retry — Allows students to retake the quiz after their first attempt.</option>
                      <option value="REVEAL">Reveal — Shows correct answers after submission.</option>
                      <option value="DEFAULT">Default — Standard feedback mode.</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Attempts Allowed</label>
                      <input type="number" name="attemptsAllowed" defaultValue={quiz?.attemptsAllowed ?? 10} min={1} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Passing Grade (%)</label>
                      <input type="number" name="passingGrade" defaultValue={quiz?.passingGrade ?? 80} min={0} max={100} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Max Questions to Answer</label>
                      <input type="number" name="maxQuestionsAllowed" defaultValue={quiz?.maxQuestionsAllowed ?? 10} min={1} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Advanced Settings */}
              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <button type="button" className="w-full flex items-center justify-between px-5 py-4 font-semibold text-sm text-gray-900">
                  Advanced Settings <ChevronDown size={16} className="text-gray-400" />
                </button>
                <div className="px-5 pb-5 space-y-4 border-t border-gray-200 mt-0">
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Question Layout</label>
                      <select name="questionLayout" defaultValue={quiz?.questionLayout || "SINGLE"} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
                        <option value="SINGLE">Single question</option>
                        <option value="ALL">All at once</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Question Order</label>
                      <select name="questionOrder" defaultValue={quiz?.questionOrder || "RANDOM"} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
                        <option value="RANDOM">Random</option>
                        <option value="SEQUENTIAL">Sequential</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Short Answer Char Limit</label>
                      <input type="number" name="shortAnswerCharLimit" defaultValue={quiz?.shortAnswerCharLimit ?? 200} min={1} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Essay Char Limit</label>
                      <input type="number" name="essayCharLimit" defaultValue={quiz?.essayCharLimit ?? 500} min={1} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <button type="submit" disabled={quizFetcher.state !== "idle"} className="px-6 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60">
                  {quizFetcher.state !== "idle" ? "Saving…" : "Save Settings"}
                </button>
              </div>
            </quizFetcher.Form>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 1: Basics ────────────────────────────────────────────────────────────

function BasicsStep({ course, fetcher }: { course: any; fetcher: any }) {
  const [courseType, setCourseType] = useState<string>(course.courseType || "FREE");
  const [contentType, setContentType] = useState<string>(course.contentType || "STORYLINE");
  const [isQA, setIsQA] = useState<boolean>(course.isQA ?? false);
  const [iconSet, setIconSet] = useState<string>(course.iconSet ?? "");
  const [isPublicCourse, setIsPublicCourse] = useState<boolean>(course.isPublic ?? false);

  const titleSlug = course.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  return (
    <fetcher.Form method="post" className="flex gap-6 items-start">
      <input type="hidden" name="intent" value="update_basics" />
      <input type="hidden" name="courseType" value={courseType} />
      <input type="hidden" name="contentType" value={contentType} />
      <input type="hidden" name="isQA" value={String(isQA)} />
      <input type="hidden" name="isPublicCourse" value={String(isPublicCourse)} />

      {/* Left main column */}
      <div className="flex-1 space-y-5 min-w-0">
        {/* Title */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="title"
            defaultValue={course.title}
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder="Enter course title"
          />
          <p className="text-[11px] text-gray-400 mt-1.5">
            Course URL: <span className="text-gray-500">http://instructionalgraphics.local/courses/{titleSlug}</span>
          </p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Summary</label>
          <input
            type="text"
            name="summary"
            defaultValue={course.summary || ""}
            placeholder="Short one-line overview shown on course cards"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Description */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
          <textarea
            name="description"
            defaultValue={course.description || ""}
            rows={6}
            placeholder="Detailed description of this course…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        </div>

        {/* Options */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 font-semibold text-sm text-gray-900">Options</div>
          <div className="p-5 space-y-4">
            {/* General tab content */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Difficulty Level</label>
              <select
                name="difficulty"
                defaultValue={course.difficulty || "Intermediate"}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="Beginner">Beginner</option>
                <option value="Intermediate">Intermediate</option>
                <option value="Advanced">Advanced</option>
              </select>
            </div>

            <div className="flex items-center justify-between py-2 border-t border-gray-100">
              <div>
                <p className="text-sm font-medium text-gray-700">Public Course</p>
                <p className="text-xs text-gray-400">Visible in the public catalog</p>
              </div>
              <button
                type="button"
                onClick={() => setIsPublicCourse((v) => !v)}
                style={{ backgroundColor: isPublicCourse ? "#2563eb" : "#e5e7eb" }}
                className="w-11 h-6 rounded-full relative transition-colors duration-200"
              >
                <span
                  style={{ transform: isPublicCourse ? "translateX(20px)" : "translateX(2px)" }}
                  className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                />
              </button>
            </div>

            <div className="flex items-center justify-between py-2 border-t border-gray-100">
              <div>
                <p className="text-sm font-medium text-gray-700">Q&A</p>
                <p className="text-xs text-gray-400">Enable Q&A for this course</p>
              </div>
              <button
                type="button"
                onClick={() => setIsQA((v) => !v)}
                style={{ backgroundColor: isQA ? "#2563eb" : "#e5e7eb" }}
                className="w-11 h-6 rounded-full relative transition-colors duration-200"
              >
                <span
                  style={{ transform: isQA ? "translateX(20px)" : "translateX(2px)" }}
                  className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                />
              </button>
            </div>

            {/* Content type */}
            <div className="border-t border-gray-100 pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Default Content Type</label>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { type: "STORYLINE", icon: MonitorPlay, label: "Articulate Storyline", sub: "Embedded iframe" },
                  { type: "VIDEO", icon: Video, label: "External Video", sub: "YouTube / Vimeo / MP4" },
                ].map(({ type, icon: Icon, label, sub }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setContentType(type)}
                    className={`flex items-center gap-3 border-2 rounded-xl px-4 py-3 transition-all text-left ${
                      contentType === type
                        ? type === "STORYLINE" ? "border-purple-500 bg-purple-50 text-purple-700" : "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                    }`}
                  >
                    <Icon size={18} />
                    <div>
                      <p className="text-sm font-semibold">{label}</p>
                      <p className="text-xs opacity-70">{sub}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Flat course URL */}
            <div className="border-t border-gray-100 pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {contentType === "STORYLINE" ? "Storyline Embed URL" : "Video URL"}
                <span className="text-gray-400 font-normal text-xs ml-1">(flat — no curriculum)</span>
              </label>
              {contentType === "STORYLINE" ? (
                <input type="url" name="embedUrl" defaultValue={course.embedUrl || ""} placeholder="https://…/story_html5.html" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
              ) : (
                <input type="url" name="videoUrl" defaultValue={course.videoUrl || ""} placeholder="YouTube, Vimeo, or .mp4 URL" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="w-72 shrink-0 space-y-4">
        {/* Visibility */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Visibility</label>
          <select key={course.status} name="status" defaultValue={course.status} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <option value="PUBLISHED">Public</option>
            <option value="DRAFT">Draft</option>
          </select>
          <p className="text-[11px] text-gray-400">Last updated on {new Date(course.updatedAt).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}</p>
        </div>

        {/* Module icons */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Module Icons</label>
          <p className="text-[11px] text-gray-500 -mt-1">
            Shown beside each module in the course player. Icons are applied in module order.
          </p>
          <input type="hidden" name="iconSet" value={iconSet} />
          <div className="space-y-1.5">
            {([
              { value: "", label: "Default (generic icons)" },
              { value: "market", label: "Markets set" },
              { value: "money", label: "Money set" },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setIconSet(opt.value)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                  iconSet === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-900 font-medium"
                    : "border-gray-200 hover:border-gray-300 text-gray-700"
                }`}
              >
                <span
                  className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                    iconSet === opt.value ? "border-blue-600 bg-blue-600" : "border-gray-300"
                  }`}
                />
                {opt.label}
              </button>
            ))}
          </div>
          {isIconSet(iconSet) && (
            <div className="flex flex-wrap gap-1.5 pt-1 p-2 rounded-lg" style={{ background: "#001A38" }}>
              {iconSetImages(iconSet).map((src, i) => (
                <img key={src} src={src} alt={`Module ${i + 1}`} title={`Module ${i + 1}`} className="w-6 h-6 object-contain" />
              ))}
            </div>
          )}
        </div>

        {/* Featured Image */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Featured Image</label>
          <ImageUpload name="thumbnailUrl" defaultValue={course.thumbnailUrl || ""} label="Upload Thumbnail" />
        </div>

        {/* Intro Video */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Intro Video</label>
          <input type="url" name="introVideoUrl" defaultValue={course.introVideoUrl || ""} placeholder="YouTube or Vimeo URL" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
          <p className="text-[11px] text-gray-400">MP4, and WebM formats, up to 300 MB</p>
        </div>

        {/* Pricing Model */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Pricing Model</label>
          <div className="flex gap-3">
            {["FREE", "PAID"].map((type) => (
              <label key={type} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="_courseType"
                  checked={courseType === type}
                  onChange={() => setCourseType(type)}
                  className="accent-blue-600"
                />
                <span className="text-sm text-gray-700">{type === "FREE" ? "Free" : "Paid"}</span>
              </label>
            ))}
          </div>
          {courseType === "PAID" && (
            <div className="space-y-2 pt-1">
              <div className="relative">
                <span className="absolute inset-y-0 left-3 flex items-center text-gray-400 text-sm">$</span>
                <input type="number" name="price" defaultValue={course.price || ""} min="0" step="0.01" placeholder="0.00" className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <input type="text" name="shopifyProductId" defaultValue={course.shopifyProductId || ""} placeholder="Shopify Product ID" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
            </div>
          )}
        </div>

        {/* Categories & Instructor */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <label className="block text-sm font-semibold text-gray-900">Categories</label>
          <input type="text" name="category" defaultValue={course.category || ""} placeholder="e.g. Compliance, Safety" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
          <label className="block text-sm font-semibold text-gray-900 pt-1">Instructor</label>
          <input type="text" name="instructor" defaultValue={course.instructor || ""} placeholder="e.g. Jane Smith" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" />
        </div>

        {/* Save */}
        <button
          type="submit"
          disabled={fetcher.state === "submitting"}
          className="w-full py-2.5 text-sm font-medium text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-60 shadow-sm"
        >
          {fetcher.state === "submitting" ? "Saving…" : "Save Basics"}
        </button>
      </div>
    </fetcher.Form>
  );
}

// ── Step 2: Curriculum ────────────────────────────────────────────────────────

function CurriculumStep({ course, fetcher }: { course: any; fetcher: any }) {
  const [expandedModules, setExpandedModules] = useState<Set<string>>(
    new Set(course.modules.map((m: any) => m.id)),
  );
  const [editingModuleId, setEditingModuleId] = useState<string | null>(null);
  const [showAddModule, setShowAddModule] = useState(false);
  const [lessonModal, setLessonModal] = useState<{ moduleId: string; moduleName: string; lesson?: any } | null>(null);
  const [quizModal, setQuizModal] = useState<{ moduleId: string; moduleName: string; quiz?: any } | null>(null);
  const [expandAll, setExpandAll] = useState(true);

  // Local modules state for optimistic drag-and-drop reordering
  const [localModules, setLocalModules] = useState<any[]>(course.modules);
  useEffect(() => { setLocalModules(course.modules); }, [course.modules]);

  // Lesson drag state
  const dragLesson = useRef<{ id: string; moduleId: string } | null>(null);
  const [dragOverLessonId, setDragOverLessonId] = useState<string | null>(null);

  // Module drag state
  const dragModule = useRef<string | null>(null);
  const [dragOverModuleId, setDragOverModuleId] = useState<string | null>(null);

  const handleLessonDragStart = (lessonId: string, moduleId: string) => {
    dragLesson.current = { id: lessonId, moduleId };
  };

  const handleLessonDragOver = (e: React.DragEvent, lessonId: string) => {
    e.preventDefault();
    if (dragLesson.current && dragLesson.current.id !== lessonId) {
      setDragOverLessonId(lessonId);
    }
  };

  const handleLessonDrop = (e: React.DragEvent, targetLessonId: string, moduleId: string) => {
    e.preventDefault();
    setDragOverLessonId(null);
    if (!dragLesson.current || dragLesson.current.id === targetLessonId || dragLesson.current.moduleId !== moduleId) return;

    const draggedId = dragLesson.current.id;
    dragLesson.current = null;

    // Compute outside setState - updaters must be pure (StrictMode runs them
    // twice, which used to fire two reorder requests).
    const m = localModules.find((x) => x.id === moduleId);
    if (!m) return;
    const lessons = [...m.lessons];
    const fromIdx = lessons.findIndex((l: any) => l.id === draggedId);
    const toIdx = lessons.findIndex((l: any) => l.id === targetLessonId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = lessons.splice(fromIdx, 1);
    lessons.splice(toIdx, 0, moved);
    const reordered = lessons.map((l: any, i: number) => ({ ...l, order: i }));

    setLocalModules((prev) => prev.map((x) => (x.id === moduleId ? { ...x, lessons: reordered } : x)));

    const fd = new FormData();
    fd.append("intent", "reorder_lessons");
    fd.append("items", JSON.stringify(reordered.map((l: any) => ({ id: l.id, order: l.order }))));
    fetcher.submit(fd, { method: "post" });
  };

  const handleLessonDragEnd = () => {
    dragLesson.current = null;
    setDragOverLessonId(null);
  };

  const handleModuleDragStart = (moduleId: string) => {
    dragModule.current = moduleId;
  };

  const handleModuleDragOver = (e: React.DragEvent, moduleId: string) => {
    e.preventDefault();
    if (dragModule.current && dragModule.current !== moduleId) {
      setDragOverModuleId(moduleId);
    }
  };

  const handleModuleDrop = (e: React.DragEvent, targetModuleId: string) => {
    e.preventDefault();
    setDragOverModuleId(null);
    if (!dragModule.current || dragModule.current === targetModuleId) return;

    const draggedId = dragModule.current;
    dragModule.current = null;

    const modules = [...localModules];
    const fromIdx = modules.findIndex((m) => m.id === draggedId);
    const toIdx = modules.findIndex((m) => m.id === targetModuleId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = modules.splice(fromIdx, 1);
    modules.splice(toIdx, 0, moved);
    const reordered = modules.map((m, i) => ({ ...m, order: i }));

    const fd = new FormData();
    fd.append("intent", "reorder_modules");
    fd.append("items", JSON.stringify(reordered.map((m) => ({ id: m.id, order: m.order }))));
    fetcher.submit(fd, { method: "post" });

    setLocalModules(reordered);
  };

  const handleModuleDragEnd = () => {
    dragModule.current = null;
    setDragOverModuleId(null);
  };

  const totalLessons = course.modules.reduce((sum: number, m: any) => sum + m.lessons.length + m.quizzes.length, 0);

  const toggleModule = (id: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleExpandAll = () => {
    if (expandAll) {
      setExpandedModules(new Set());
    } else {
      setExpandedModules(new Set(localModules.map((m: any) => m.id)));
    }
    setExpandAll((v) => !v);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Curriculum</h2>
        {localModules.length > 0 && (
          <button onClick={handleExpandAll} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
            {expandAll ? "Collapse All" : "Expand All"}
          </button>
        )}
      </div>

      {/* Module list */}
      <div className="space-y-3">
        {localModules.map((module: any) => {
          const isExpanded = expandedModules.has(module.id);
          const isEditing = editingModuleId === module.id;
          const itemCount = module.lessons.length + module.quizzes.length;

          const isModuleDragOver = dragOverModuleId === module.id;
          const isModuleDragging = dragModule.current === module.id;

          return (
            <div
              key={module.id}
              draggable={!isEditing}
              onDragStart={(e) => { if (isEditing) { e.preventDefault(); return; } handleModuleDragStart(module.id); }}
              onDragOver={(e) => handleModuleDragOver(e, module.id)}
              onDrop={(e) => handleModuleDrop(e, module.id)}
              onDragEnd={handleModuleDragEnd}
              className={`rounded-xl border shadow-sm overflow-hidden transition-all select-none
                ${isModuleDragging ? "opacity-40 bg-gray-50 border-gray-200" : "bg-white border-gray-200"}
                ${isModuleDragOver ? "border-t-2 border-t-blue-500" : ""}
              `}
            >
              {/* Module header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-gray-50/80">
                <GripVertical size={16} className="text-gray-400 shrink-0 cursor-grab active:cursor-grabbing" />
                <button onClick={() => toggleModule(module.id)} className="text-gray-400 hover:text-gray-600 shrink-0">
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {isEditing ? (
                  <fetcher.Form method="post" className="flex-1 flex items-center gap-2" onSubmit={() => setEditingModuleId(null)}>
                    <input type="hidden" name="intent" value="update_module" />
                    <input type="hidden" name="id" value={module.id} />
                    <input type="text" name="title" defaultValue={module.title} autoFocus required className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500" />
                    <button type="submit" className="text-blue-600 hover:text-blue-800 px-3 py-1.5 text-xs font-medium">Save</button>
                    <button type="button" onClick={() => setEditingModuleId(null)} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100"><X size={14} /></button>
                  </fetcher.Form>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-semibold text-gray-900">{module.title}</span>
                    <span className="text-xs text-gray-400">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
                    <button onClick={() => setEditingModuleId(module.id)} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100">
                      <Edit3 size={13} />
                    </button>
                    <fetcher.Form method="post" className="inline">
                      <input type="hidden" name="intent" value="delete_module" />
                      <input type="hidden" name="id" value={module.id} />
                      <button type="submit" onClick={(e) => { if (!confirm("Delete this topic and all its content?")) e.preventDefault(); }} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50">
                        <Trash2 size={13} />
                      </button>
                    </fetcher.Form>
                  </>
                )}
              </div>

              {/* Lessons + Quizzes */}
              {isExpanded && (
                <div>
                  <div className="divide-y divide-gray-100">
                    {module.lessons.map((lesson: any, idx: number) => {
                      const cfg = lessonTypeConfig[lesson.lessonType] || lessonTypeConfig.VIDEO;
                      const Icon = cfg.icon;
                      const isDragOver = dragOverLessonId === lesson.id;
                      const isDragging = dragLesson.current?.id === lesson.id;
                      return (
                        <div
                          key={lesson.id}
                          draggable
                          onDragStart={(e) => { e.stopPropagation(); handleLessonDragStart(lesson.id, module.id); }}
                          onDragOver={(e) => { e.stopPropagation(); handleLessonDragOver(e, lesson.id); }}
                          onDrop={(e) => { e.stopPropagation(); handleLessonDrop(e, lesson.id, module.id); }}
                          onDragEnd={(e) => { e.stopPropagation(); handleLessonDragEnd(); }}
                          className={`flex items-center gap-3 px-5 py-3 group transition-colors select-none
                            ${isDragging ? "opacity-40 bg-gray-50" : "hover:bg-gray-50"}
                            ${isDragOver ? "border-t-2 border-blue-500" : ""}
                          `}
                        >
                          <GripVertical size={14} className="text-gray-400 shrink-0 cursor-grab active:cursor-grabbing" />
                          <span className="text-xs text-gray-300 w-5 text-right shrink-0">{idx + 1}</span>
                          <div className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[10px] ${cfg.color}`}>
                            <Icon size={12} />
                          </div>
                          <span className="flex-1 text-sm text-gray-800">{lesson.title}</span>
                          {lesson.duration && <span className="text-xs text-gray-400 shrink-0">{Math.floor(lesson.duration / 60)}m</span>}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => setLessonModal({ moduleId: module.id, moduleName: module.title, lesson })} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100">
                              <Edit3 size={13} />
                            </button>
                            <fetcher.Form method="post" className="inline">
                              <input type="hidden" name="intent" value="delete_lesson" />
                              <input type="hidden" name="id" value={lesson.id} />
                              <button type="submit" onClick={(e) => { if (!confirm("Delete this lesson?")) e.preventDefault(); }} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50">
                                <Trash2 size={13} />
                              </button>
                            </fetcher.Form>
                          </div>
                        </div>
                      );
                    })}

                    {module.quizzes.map((quiz: any) => (
                      <div key={quiz.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 group">
                        <GripVertical size={14} className="text-gray-200 shrink-0 cursor-grab" />
                        <div className="shrink-0 w-6 h-6 rounded flex items-center justify-center bg-amber-50">
                          <HelpCircle size={12} className="text-amber-600" />
                        </div>
                        <span className="flex-1 text-sm text-gray-800">{quiz.title}</span>
                        <span className="text-[10px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded font-medium">{quiz.questions.length} questions</span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => setQuizModal({ moduleId: module.id, moduleName: module.title, quiz })} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100">
                            <Edit3 size={13} />
                          </button>
                          <fetcher.Form method="post" className="inline">
                            <input type="hidden" name="intent" value="delete_quiz" />
                            <input type="hidden" name="id" value={quiz.id} />
                            <button type="submit" onClick={(e) => { if (!confirm("Delete this quiz?")) e.preventDefault(); }} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50">
                              <Trash2 size={13} />
                            </button>
                          </fetcher.Form>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* + Lesson + Quiz buttons */}
                  <div className="px-5 py-3 flex gap-3 border-t border-gray-100">
                    <button
                      onClick={() => setLessonModal({ moduleId: module.id, moduleName: module.title })}
                      className="flex items-center gap-1.5 text-xs text-gray-700 border border-gray-300 hover:border-gray-400 px-3 py-1.5 rounded-lg transition-colors font-medium"
                    >
                      <Plus size={12} /> Lesson
                    </button>
                    <button
                      onClick={() => setQuizModal({ moduleId: module.id, moduleName: module.title })}
                      className="flex items-center gap-1.5 text-xs text-gray-700 border border-gray-300 hover:border-gray-400 px-3 py-1.5 rounded-lg transition-colors font-medium"
                    >
                      <Plus size={12} /> Quiz
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Add Topic */}
        <div className="bg-white rounded-xl border border-dashed border-gray-300 overflow-hidden">
          {showAddModule ? (
            <fetcher.Form method="post" className="flex items-center gap-3 px-4 py-3" onSubmit={() => { setShowAddModule(false); }}>
              <input type="hidden" name="intent" value="create_module" />
              <BookOpen size={16} className="text-gray-400 shrink-0" />
              <input type="text" name="title" autoFocus required placeholder="Topic title…" className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500" />
              <button type="submit" className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700">Add</button>
              <button type="button" onClick={() => setShowAddModule(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </fetcher.Form>
          ) : (
            <button onClick={() => setShowAddModule(true)} className="w-full flex items-center gap-2 px-4 py-4 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 transition-colors font-medium">
              <Plus size={16} />
              <span>Add Topic</span>
            </button>
          )}
        </div>

        {/* Empty state */}
        {localModules.length === 0 && !showAddModule && (
          <div className="text-center py-16 text-gray-400">
            <div className="w-32 h-32 mx-auto mb-4 opacity-60">
              <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="100" cy="90" r="50" fill="#e8f0fe" />
                <rect x="70" y="70" width="60" height="8" rx="4" fill="#93c5fd" />
                <rect x="70" y="85" width="45" height="8" rx="4" fill="#93c5fd" />
                <rect x="70" y="100" width="55" height="8" rx="4" fill="#93c5fd" />
              </svg>
            </div>
            <p className="font-medium text-gray-500 text-sm">Start building your course!</p>
            <p className="text-xs text-gray-400 mt-1">Add Topics, Lessons, and Quizzes to get started.</p>
          </div>
        )}
      </div>

      {/* Modals */}
      {lessonModal && (
        <LessonModal
          moduleId={lessonModal.moduleId}
          moduleName={lessonModal.moduleName}
          lesson={
            lessonModal.lesson
              ? (localModules.flatMap((m: any) => m.lessons).find((l: any) => l.id === lessonModal.lesson.id) ?? lessonModal.lesson)
              : undefined
          }
          fetcher={fetcher}
          onClose={() => setLessonModal(null)}
        />
      )}
      {quizModal && (
        <QuizModal
          moduleId={quizModal.moduleId}
          moduleName={quizModal.moduleName}
          // Always the freshest copy: after create_question/create_answer the
          // loader revalidates and the new rows must show up inside the open modal.
          quiz={
            quizModal.quiz
              ? (localModules.flatMap((m: any) => m.quizzes).find((q: any) => q.id === quizModal.quiz.id) ?? quizModal.quiz)
              : undefined
          }
          fetcher={fetcher}
          onClose={() => setQuizModal(null)}
        />
      )}
    </div>
  );
}

// ── Step 4: Resources & Glossary ──────────────────────────────────────────────

function formatBytes(n: number | null | undefined) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ResourcesStep({
  course,
  resources,
  glossary,
}: {
  course: any;
  resources: any[];
  glossary: any[];
}) {
  const lessons: Array<{ id: string; title: string; module: string }> =
    (course.modules ?? []).flatMap((m: any) =>
      (m.lessons ?? []).map((l: any) => ({ id: l.id, title: l.title, module: m.title })),
    );

  return (
    <div className="max-w-4xl space-y-8">
      <ResourcesPanel resources={resources} lessons={lessons} />
      <GlossaryPanel glossary={glossary} />
    </div>
  );
}

// ── Resources ────────────────────────────────────────────────────────────────

function ResourcesPanel({
  resources,
  lessons,
}: {
  resources: any[];
  lessons: Array<{ id: string; title: string; module: string }>;
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) setAdding(false);
  }, [fetcher.state, fetcher.data]);

  return (
    <section className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Paperclip size={17} className="text-gray-500" />
          <h2 className="font-semibold text-gray-900">Resources</h2>
          <span className="text-xs text-gray-400">({resources.length})</span>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg font-medium transition-colors"
          >
            <Plus size={14} /> Add resource
          </button>
        )}
      </div>

      <p className="px-5 pt-3 text-xs text-gray-500">
        Handouts for this course. Learners see them in the course player&rsquo;s{" "}
        <strong>Resources</strong> drawer and on their Resources page. Files are downloaded
        through a licence-checked link, so students of other courses cannot open them.
      </p>

      {fetcher.data?.error && (
        <div className="mx-5 mt-3 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
          <AlertCircle size={14} className="shrink-0" /> {fetcher.data.error}
        </div>
      )}

      {adding && (
        <ResourceForm lessons={lessons} fetcher={fetcher} onCancel={() => setAdding(false)} />
      )}

      {resources.length === 0 && !adding ? (
        <div className="px-5 py-10 text-center">
          <Paperclip size={26} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No resources yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            The Resources link stays hidden for learners until you add one.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {resources.map((r, i) => (
            <ResourceRow key={r.id} r={r} i={i} total={resources.length} lessons={lessons} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResourceForm({
  lessons,
  fetcher,
  onCancel,
  existing,
}: {
  lessons: Array<{ id: string; title: string; module: string }>;
  fetcher: any;
  onCancel: () => void;
  existing?: any;
}) {
  const [kind, setKind] = useState<"FILE" | "LINK">(existing?.kind === "LINK" ? "LINK" : "FILE");
  const [url, setUrl] = useState<string>(existing?.url ?? "");
  const [fileName, setFileName] = useState<string>(existing?.fileName ?? "");
  const [fileType, setFileType] = useState<string>(existing?.fileType ?? "");
  const [fileSize, setFileSize] = useState<number | "">(existing?.fileSize ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "document");
      const res = await fetch("/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? "Upload failed");
      setUrl(json.url);
      setFileName(json.fileName ?? file.name);
      setFileType(json.fileType ?? file.type ?? "");
      setFileSize(json.fileSize ?? file.size);
    } catch (err: any) {
      setUploadError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <fetcher.Form method="post" className="px-5 py-4 bg-gray-50 border-y border-gray-200 space-y-4">
      <input type="hidden" name="intent" value={existing ? "update_resource" : "create_resource"} />
      {existing && <input type="hidden" name="id" value={existing.id} />}
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="url" value={url} />
      <input type="hidden" name="fileName" value={fileName} />
      <input type="hidden" name="fileType" value={fileType} />
      <input type="hidden" name="fileSize" value={fileSize === "" ? "" : String(fileSize)} />

      <div className="flex gap-2">
        {(["FILE", "LINK"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setKind(k);
              setUrl("");
              setFileName("");
              setFileType("");
              setFileSize("");
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              kind === k
                ? "border-blue-500 bg-blue-50 text-blue-900 font-medium"
                : "border-gray-200 text-gray-600 hover:border-gray-300"
            }`}
          >
            {k === "FILE" ? <Paperclip size={13} /> : <Link2 size={13} />}
            {k === "FILE" ? "Upload a file" : "External link"}
          </button>
        ))}
      </div>

      {kind === "FILE" ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">File</label>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm border border-gray-300 bg-white hover:bg-gray-50 px-3 py-2 rounded-lg cursor-pointer transition-colors">
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {uploading ? "Uploading…" : "Choose file"}
              <input
                type="file"
                className="hidden"
                onChange={handleFile}
                disabled={uploading}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rtf"
              />
            </label>
            {fileName && !uploading && (
              <span className="text-sm text-gray-700 truncate">
                {fileName}{" "}
                <span className="text-gray-400">{formatBytes(Number(fileSize) || null)}</span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-1">
            PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP — up to 50 MB.
          </p>
          {uploadError && <p className="text-xs text-red-600 mt-1">{uploadError}</p>}
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Link</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=… or any URL"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            YouTube and Vimeo play inside the drawer. Note: an external link is served by that
            site, so it cannot be licence-checked the way an uploaded file is.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Title</label>
          <input
            name="title"
            defaultValue={existing?.title ?? ""}
            required
            placeholder="Module 1 Worksheet"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Show with</label>
          <select
            name="lessonId"
            defaultValue={existing?.lessonId ?? ""}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-500"
          >
            <option value="">The whole course</option>
            {lessons.map((l) => (
              <option key={l.id} value={l.id}>
                {l.module} › {l.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Description (optional)
        </label>
        <input
          name="description"
          defaultValue={existing?.description ?? ""}
          placeholder="What is it for?"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!url || uploading || fetcher.state !== "idle"}
          className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {existing ? "Save changes" : "Add resource"}
        </button>
      </div>
    </fetcher.Form>
  );
}

function ResourceRow({
  r,
  i,
  total,
  lessons,
}: {
  r: any;
  i: number;
  total: number;
  lessons: Array<{ id: string; title: string; module: string }>;
}) {
  const rowFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [editing, setEditing] = useState(false);
  const lesson = lessons.find((l) => l.id === r.lessonId);

  useEffect(() => {
    if (rowFetcher.state === "idle" && rowFetcher.data?.success) setEditing(false);
  }, [rowFetcher.state, rowFetcher.data]);

  if (editing) {
    return (
      <li>
        <ResourceForm
          lessons={lessons}
          fetcher={rowFetcher}
          existing={r}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className={`flex items-center gap-3 px-5 py-3 ${r.isActive ? "" : "bg-gray-50"}`}>
      <span className="text-xs text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          r.kind === "LINK" ? "bg-purple-50 text-purple-600" : "bg-blue-50 text-blue-600"
        }`}
      >
        {r.kind === "LINK" ? <Link2 size={15} /> : <Paperclip size={15} />}
      </div>

      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-medium truncate ${r.isActive ? "text-gray-900" : "text-gray-500"}`}
        >
          {r.title}
          {!r.isActive && (
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              hidden
            </span>
          )}
        </p>
        <p className="text-xs text-gray-400 truncate">
          {lesson ? `${lesson.module} › ${lesson.title}` : "Whole course"}
          {r.fileName ? ` · ${r.fileName}` : ""}
          {r.fileSize ? ` · ${formatBytes(r.fileSize)}` : ""}
        </p>
      </div>

      <rowFetcher.Form method="post" className="flex items-center shrink-0">
        <input type="hidden" name="intent" value="move_resource" />
        <input type="hidden" name="id" value={r.id} />
        <button
          type="submit"
          name="direction"
          value="up"
          disabled={i === 0}
          title="Move up"
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="submit"
          name="direction"
          value="down"
          disabled={i === total - 1}
          title="Move down"
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronDown size={14} />
        </button>
      </rowFetcher.Form>

      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit"
        className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 shrink-0"
      >
        <Edit3 size={14} />
      </button>

      <rowFetcher.Form method="post" className="shrink-0">
        <input type="hidden" name="intent" value="toggle_resource" />
        <input type="hidden" name="id" value={r.id} />
        <button
          type="submit"
          title={r.isActive ? "Hide from learners" : "Show to learners"}
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
        >
          {r.isActive ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </rowFetcher.Form>

      <rowFetcher.Form method="post" className="shrink-0">
        <input type="hidden" name="intent" value="delete_resource" />
        <input type="hidden" name="id" value={r.id} />
        <button
          type="submit"
          title="Delete"
          onClick={(e) => {
            if (!confirm(`Delete "${r.title}"?`)) e.preventDefault();
          }}
          className="p-1.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
        >
          <Trash2 size={14} />
        </button>
      </rowFetcher.Form>
    </li>
  );
}

// ── Glossary ─────────────────────────────────────────────────────────────────

function GlossaryPanel({ glossary }: { glossary: any[] }) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) formRef.current?.reset();
  }, [fetcher.state, fetcher.data]);

  return (
    <section className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-200">
        <BookMarked size={17} className="text-gray-500" />
        <h2 className="font-semibold text-gray-900">Glossary</h2>
        <span className="text-xs text-gray-400">({glossary.length})</span>
      </div>

      <p className="px-5 pt-3 text-xs text-gray-500">
        Terms for this course only. Learners open them from the course player&rsquo;s{" "}
        <strong>Glossary</strong> link; the link stays hidden until there is at least one term.
      </p>

      {fetcher.data?.error && (
        <div className="mx-5 mt-3 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
          <AlertCircle size={14} className="shrink-0" /> {fetcher.data.error}
        </div>
      )}

      <fetcher.Form
        ref={formRef}
        method="post"
        className="px-5 py-4 flex flex-col sm:flex-row gap-3 border-b border-gray-100"
      >
        <input type="hidden" name="intent" value="create_term" />
        <input
          name="term"
          required
          placeholder="Term (e.g. Margin Account)"
          className="sm:w-64 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
        />
        <input
          name="definition"
          required
          placeholder="Definition"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="flex items-center justify-center gap-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2 rounded-lg font-medium transition-colors shrink-0"
        >
          <Plus size={14} /> Add
        </button>
      </fetcher.Form>

      {glossary.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <BookMarked size={26} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No terms yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {glossary.map((t) => (
            <GlossaryRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GlossaryRow({ t }: { t: any }) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) setEditing(false);
  }, [fetcher.state, fetcher.data]);

  if (editing) {
    return (
      <li className="px-5 py-3 bg-gray-50">
        <fetcher.Form method="post" className="flex flex-col sm:flex-row gap-3">
          <input type="hidden" name="intent" value="update_term" />
          <input type="hidden" name="id" value={t.id} />
          <input
            name="term"
            defaultValue={t.term}
            required
            className="sm:w-64 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            name="definition"
            defaultValue={t.definition}
            required
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </fetcher.Form>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <div className="sm:w-64 shrink-0">
        <p className="text-sm font-semibold text-gray-900">{t.term}</p>
      </div>
      <p className="flex-1 text-sm text-gray-600 leading-relaxed">{t.definition}</p>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit"
        className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 shrink-0"
      >
        <Edit3 size={14} />
      </button>
      <fetcher.Form method="post" className="shrink-0">
        <input type="hidden" name="intent" value="delete_term" />
        <input type="hidden" name="id" value={t.id} />
        <button
          type="submit"
          title="Delete"
          onClick={(e) => {
            if (!confirm(`Delete "${t.term}"?`)) e.preventDefault();
          }}
          className="p-1.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
        >
          <Trash2 size={14} />
        </button>
      </fetcher.Form>
    </li>
  );
}

// ── Step 3: Additional ────────────────────────────────────────────────────────

function AdditionalStep({ course, fetcher }: { course: any; fetcher: any }) {
  // Derived from lesson durations - there is no separate stored value.
  const totalSeconds = (course.modules ?? [])
    .flatMap((m: any) => m.lessons ?? [])
    .reduce((sum: number, l: any) => sum + (Number(l.duration) || 0), 0);
  const totalHours = Math.floor(totalSeconds / 3600);
  const totalMins = Math.floor((totalSeconds % 3600) / 60);

  return (
    <fetcher.Form method="post" className="max-w-2xl space-y-6">
      <input type="hidden" name="intent" value="update_additional" />

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <div>
          <h3 className="font-semibold text-gray-900 mb-1">Overview</h3>
          <p className="text-sm text-gray-500">Provide essential course information to attract and inform potential students</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">What Will I Learn?</label>
          <textarea
            name="whatYouLearn"
            defaultValue={course.whatYouLearn || ""}
            rows={4}
            placeholder="Define the key takeaways from this course (list one benefit per line)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Target Audience</label>
          <textarea
            name="targetAudience"
            defaultValue={course.targetAudience || ""}
            rows={3}
            placeholder="Specify the target audience that will benefit the most from the course. (One Line Per target audience)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Total Course Duration</label>
          <div className="flex gap-3 items-center">
            <span className="text-sm font-semibold text-gray-900">{totalHours} hour(s) {totalMins} min(s)</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">Calculated from the duration of each lesson in the curriculum.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Materials Included</label>
          <textarea
            name="materialsIncluded"
            defaultValue={course.materialsIncluded || ""}
            rows={4}
            placeholder="A list of assets you will be providing for the students in this course (One Per Line)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Requirements/Instructions</label>
          <textarea
            name="requirements"
            defaultValue={course.requirements || ""}
            rows={4}
            placeholder="Additional requirements or special instructions for the students (One Line Per requirement)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={fetcher.state === "submitting"}
        className="px-6 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-60 shadow-sm"
      >
        {fetcher.state === "submitting" ? "Saving…" : "Save Additional Info"}
      </button>
    </fetcher.Form>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function CourseBuilder() {
  const { course, resources, glossary } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);

  const isPublished = course.status === "PUBLISHED";

  const STEPS = [
    { num: 1, label: "Basics" },
    { num: 2, label: "Curriculum" },
    { num: 3, label: "Additional" },
    { num: 4, label: "Resources" },
  ] as const;

  return (
    <div className="min-h-screen bg-brand-beige -m-6 flex flex-col">
      {/* ── Top bar ──────────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 shrink-0 sticky top-0 z-20">
        <Link to="/courses" className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft size={18} />
        </Link>

        <div className="flex items-center gap-1 text-sm font-semibold text-gray-700">
          Course Builder
        </div>

        <div className="w-px h-5 bg-gray-200 mx-1" />

        {/* Step indicators */}
        <div className="flex items-center gap-1">
          {STEPS.map(({ num, label }, i) => (
            <div key={num} className="flex items-center gap-1">
              <button
                onClick={() => setActiveStep(num)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors ${
                  activeStep === num
                    ? "bg-blue-600 text-white"
                    : activeStep > num
                    ? "bg-blue-100 text-blue-600"
                    : "border-2 border-gray-300 text-gray-400"
                }`}>
                  {num}
                </div>
                <span className={`text-sm font-medium ${activeStep === num ? "text-gray-900" : "text-gray-500"}`}>
                  {label}
                </span>
              </button>
              {i < STEPS.length - 1 && <span className="text-gray-300 text-xs mx-0.5">—</span>}
            </div>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Save as Draft — always targets DRAFT; no-op when already a draft */}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="set_status" />
            <input type="hidden" name="status" value="DRAFT" />
            <button
              type="submit"
              disabled={!isPublished}
              className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 hover:bg-gray-50 px-3 py-1.5 rounded-lg transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Cloud size={14} />
              {isPublished ? "Save as Draft" : "Draft"}
            </button>
          </fetcher.Form>

          {/* Publish / Unpublish — explicit target status */}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="set_status" />
            <input type="hidden" name="status" value={isPublished ? "DRAFT" : "PUBLISHED"} />
            <button
              type="submit"
              className={`flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors ${
                isPublished
                  ? "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {isPublished ? <><EyeOff size={14} /> Unpublish</> : <><Globe size={14} /> Publish</>}
            </button>
          </fetcher.Form>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────────── */}
      <main className="flex-1 p-6 overflow-y-auto">
        {activeStep === 1 && <BasicsStep course={course} fetcher={fetcher} />}
        {activeStep === 2 && <CurriculumStep course={course} fetcher={fetcher} />}
        {activeStep === 3 && <AdditionalStep course={course} fetcher={fetcher} />}
        {activeStep === 4 && (
          <ResourcesStep course={course} resources={resources} glossary={glossary} />
        )}
      </main>

      {/* ── Footer nav ───────────────────────────────────────────────────────── */}
      <footer className="bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <button
          onClick={() => setActiveStep((v) => Math.max(1, v - 1) as 1 | 2 | 3 | 4)}
          disabled={activeStep === 1}
          className="flex items-center gap-2 text-sm text-gray-700 border border-gray-300 hover:bg-gray-50 px-4 py-2 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-medium"
        >
          <ChevronRight size={16} className="rotate-180" /> Back
        </button>
        <span className="text-xs text-gray-400">Step {activeStep} of 4</span>
        <button
          onClick={() => setActiveStep((v) => Math.min(4, v + 1) as 1 | 2 | 3 | 4)}
          disabled={activeStep === 4}
          className="flex items-center gap-2 text-sm text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Next <ChevronRight size={16} />
        </button>
      </footer>
    </div>
  );
}
