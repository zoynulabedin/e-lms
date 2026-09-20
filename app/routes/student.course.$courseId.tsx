import { data } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { computeCourseAccess, requireCourseAccess } from "../utils/access.server";
import { recomputeCourseProgress } from "../utils/progress.server";
import { moduleIcon, GETTING_STARTED_ICON } from "../utils/module-icons";

/** Cream highlight + navy text used for the lesson/quiz currently playing. */
const ACTIVE_BG = "#F5E7C8";
const ACTIVE_FG = "#001A38";
/** Light course-player header. */
const HEADER_BG = "#FCF9F7";
/** Footer lesson-navigation buttons. */
const GOLD = "#BE924C";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  MonitorPlay,
  Video,
  FileText,
  Download,
  Play,
  X,
  HelpCircle,
  Timer,
  Trophy,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Check,
  PlayCircle,
  BookOpen,
  Award,
  RotateCcw,
  Maximize2,
  Lock,
  Paperclip,
  BookMarked,
  Link2,
  ExternalLink,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { HlsPlayer } from "../components/HlsPlayer";
import { StorylinePlayer } from "../components/StorylinePlayer";

// ── URL helpers ───────────────────────────────────────────────────────────────

function getYouTubeId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/embed\/([^?]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function getVimeoId(url: string): string | null {
  const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv)(\?.*)?$/i;

function resolveVideoEmbed(raw: string): {
  type: "youtube" | "vimeo" | "iframe" | "hls" | "direct";
  src: string;
} {
  const trimmed = raw.trim();
  // Highest priority: if admin pasted a full <iframe> tag, extract its src
  if (trimmed.toLowerCase().startsWith("<iframe")) {
    const match = trimmed.match(/\bsrc=["']([^"']+)["']/i);
    if (match) return { type: "iframe", src: match[1] };
  }
  const ytId = getYouTubeId(trimmed);
  if (ytId)
    return { type: "youtube", src: `https://www.youtube.com/embed/${ytId}?rel=0&modestbranding=1` };
  const vimeoId = getVimeoId(trimmed);
  if (vimeoId)
    return { type: "vimeo", src: `https://player.vimeo.com/video/${vimeoId}` };
  if (trimmed.includes("wistia.com"))
    return { type: "iframe", src: trimmed.replace("/medias/", "/embed/iframe/") };
  if (trimmed.includes(".m3u8")) {
    // The proxy only relays the Storyline host (needed there for CORS);
    // HLS hosted anywhere else keeps playing directly.
    let proxied = false;
    try { proxied = new URL(trimmed).hostname === "courses.instructionalgraphics.org"; } catch {}
    return { type: "hls", src: proxied ? `/api/video-proxy?url=${encodeURIComponent(trimmed)}` : trimmed };
  }
  if (VIDEO_EXTENSIONS.test(trimmed))
    return { type: "direct", src: trimmed };
  // Everything else (HTML pages, relative paths, unknown embeds) → iframe
  return { type: "iframe", src: trimmed };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const courseId = params.courseId!;

  const [license, enrollment, course] = await Promise.all([
    prisma.license.findFirst({
      where: { courseId, userId: user.id, status: "ACTIVE" },
    }),
    prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: user.id, courseId } },
    }),
    // Explicit select: an `include` pulls every scalar column, so a column
     // added by a migration that has not been applied yet would take the whole
     // player down. Listing fields also keeps unused course data off the wire.
    prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        description: true,
        contentType: true,
        courseType: true,
        status: true,
        embedUrl: true,
        videoUrl: true,
        modules: {
          orderBy: { order: "asc" },
          include: { lessons: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
        },
      },
    }),
  ]);

  if (!course) throw data({ message: "Course not found." }, { status: 404 });

  // Module icon set — read separately so a not-yet-migrated database only
  // costs the icons, not the whole page.
  const iconSet = await prisma
    .$queryRaw<Array<{ iconSet: string | null }>>`SELECT "iconSet" FROM "Course" WHERE id = ${courseId}`
    .then((rows) => rows[0]?.iconSet ?? null)
    .catch(() => null);

  const hasAccess = computeCourseAccess(course, license, enrollment);

  if (!hasAccess)
    throw data({ message: "You don't have access to this course." }, { status: 403 });

  await prisma.progress.upsert({
    where: { userId_courseId: { userId: user.id, courseId } },
    update: { lastAccessedAt: new Date() },
    create: { userId: user.id, courseId, lastAccessedAt: new Date() },
  });

  const [progress, lessonProgresses] = await Promise.all([
    prisma.progress.findUnique({
      where: { userId_courseId: { userId: user.id, courseId } },
    }),
    prisma.lessonProgress.findMany({
      where: { userId: user.id, isCompleted: true, lesson: { module: { courseId } } },
      select: { lessonId: true, isCompleted: true },
    }),
  ]);

  // Quizzes with questions and answers (no isCorrect exposed)
  const quizRows = await prisma.$queryRaw<any[]>`
    SELECT * FROM "Quiz"
    WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
    ORDER BY "order", "createdAt"
  `;

  const questionRows = await prisma.$queryRaw<any[]>`
    SELECT * FROM "Question"
    WHERE "quizId" IN (
      SELECT id FROM "Quiz"
      WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
    )
    ORDER BY "order"
  `;

  const answerRows = await prisma.$queryRaw<any[]>`
    SELECT a.id, a."questionId", a.text, a."imageUrl", a."videoUrl", q."questionType",
      CASE WHEN q."questionType" = 'TRUE_FALSE' THEN a."isCorrect" ELSE NULL END AS "isCorrect",
      CASE WHEN q."questionType" = 'MATCHING' THEN a."matchText" ELSE NULL END AS "matchText"
    FROM "Answer" a
    JOIN "Question" q ON a."questionId" = q.id
    WHERE a."questionId" IN (
      SELECT id FROM "Question"
      WHERE "quizId" IN (
        SELECT id FROM "Quiz"
        WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
      )
    )
    ORDER BY a."order", a.id
  `;

  const quizAttemptRows = await prisma.$queryRaw<any[]>`
    SELECT * FROM "QuizAttempt"
    WHERE "userId" = ${user.id}
    AND "quizId" IN (
      SELECT id FROM "Quiz"
      WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
    )
    ORDER BY "submittedAt" DESC
  `;

  const answersMap: Record<string, any[]> = {};
  for (const a of answerRows) {
    if (!answersMap[a.questionId]) answersMap[a.questionId] = [];
    answersMap[a.questionId].push(a);
  }
  // ORDERING: the stored order IS the answer key, so the array must not
  // reach the browser in that order. Shuffle server-side, stable per
  // user+question so re-renders/reloads don't reshuffle mid-attempt.
  for (const [qid, list] of Object.entries(answersMap)) {
    if (list[0]?.questionType !== "ORDERING") continue;
    let h = 2166136261;
    for (const ch of `${user.id}:${qid}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    for (let i = list.length - 1; i > 0; i--) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      const j = (h >>> 0) % (i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  const questionsMap: Record<string, any[]> = {};
  for (const q of questionRows) {
    (q as any).answers = answersMap[q.id] || [];
    if (q.questionType === "MATCHING") {
      // The right-hand column is offered as a shuffled option list; the
      // pairing (which matchText belongs to which left item) never leaves the server.
      const opts = Array.from(
        new Set((q as any).answers.map((a: any) => String(a.matchText ?? "").trim()).filter(Boolean)),
      ) as string[];
      let h = 2166136261;
      for (const ch of `${user.id}:${q.id}:m`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      for (let i = opts.length - 1; i > 0; i--) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        const j = (h >>> 0) % (i + 1);
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      (q as any).matchOptions = opts;
      for (const a of (q as any).answers) delete a.matchText;
    }
    if (!questionsMap[q.quizId]) questionsMap[q.quizId] = [];
    questionsMap[q.quizId].push(q);
  }

  const attemptsMap: Record<string, any> = {};
  const attemptCountMap: Record<string, number> = {};
  const passedMap: Record<string, boolean> = {};
  for (const a of quizAttemptRows) {
    if (!attemptsMap[a.quizId]) attemptsMap[a.quizId] = a; // rows are newest-first
    attemptCountMap[a.quizId] = (attemptCountMap[a.quizId] ?? 0) + 1;
    if (a.isPassed) passedMap[a.quizId] = true;
  }

  const quizzesWithData = quizRows.map((q) => ({
    ...q,
    questions: questionsMap[q.id] || [],
    latestAttempt: attemptsMap[q.id] || null,
    attemptCount: attemptCountMap[q.id] ?? 0,
    // A pass is sticky: failing a later retake does not un-pass the quiz.
    hasPassed: passedMap[q.id] ?? false,
  }));

  const quizzesModuleMap: Record<string, any[]> = {};
  for (const q of quizzesWithData) {
    if (!quizzesModuleMap[q.moduleId]) quizzesModuleMap[q.moduleId] = [];
    quizzesModuleMap[q.moduleId].push(q);
  }

  const completedLessonIds = new Set(
    lessonProgresses.filter((lp) => lp.isCompleted).map((lp) => lp.lessonId),
  );

  const allItems: Array<{ type: "lesson" | "quiz"; item: any; module: any }> = [];
  for (const mod of course.modules) {
    const modLessons = mod.lessons.map((l: any) => ({
      type: "lesson" as const, item: l, module: mod, order: Number(l.order),
    }));
    const modQuizzes = (quizzesModuleMap[mod.id] || []).map((q: any) => ({
      type: "quiz" as const, item: q, module: mod, order: Number(q.order),
    }));
    const combined = [...modLessons, ...modQuizzes].sort((a, b) => a.order - b.order);
    for (const entry of combined) {
      allItems.push({ type: entry.type, item: entry.item, module: entry.module });
    }
  }

  // Resources and glossary for THIS course. The access check above has already
  // passed, so anything read here is something the learner holds a licence for;
  // a resource attached to a different course is never fetched. Both tolerate a
  // server whose migrations/client predate the feature.
  const [resources, glossary] = await Promise.all([
    prisma.courseResource
      .findMany({
        where: { courseId, isActive: true },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          description: true,
          kind: true,
          lessonId: true,
          fileName: true,
          fileSize: true,
        },
      })
      .catch((err: unknown) => {
        console.error("[course] CourseResource unavailable:", err);
        return [] as never[];
      }),
    prisma.glossaryTerm
      .findMany({
        where: { courseId },
        orderBy: [{ term: "asc" }],
        select: { id: true, term: true, definition: true },
      })
      .catch((err: unknown) => {
        console.error("[course] GlossaryTerm unavailable:", err);
        return [] as never[];
      }),
  ]);

  const url = new URL(request.url);
  const lessonId = url.searchParams.get("lesson");
  const quizId = url.searchParams.get("quiz");

  let activeItem: { type: "lesson" | "quiz"; item: any; module: any } | null =
    allItems[0] || null;

  if (quizId) {
    const found = allItems.find((i) => i.type === "quiz" && i.item.id === quizId);
    if (found) activeItem = found;
  } else if (lessonId) {
    const found = allItems.find((i) => i.type === "lesson" && i.item.id === lessonId);
    if (found) activeItem = found;
  }

  const currentIdx = activeItem
    ? allItems.findIndex((i) => i.type === activeItem!.type && i.item.id === activeItem!.item.id)
    : 0;

  const prevItem = currentIdx > 0 ? allItems[currentIdx - 1] : null;
  const nextItem = currentIdx < allItems.length - 1 ? allItems[currentIdx + 1] : null;

  // Next item of type "lesson" only — used by Storyline auto-advance so we
  // don't push the learner straight into a quiz without explicit consent.
  const nextLessonItem =
    allItems.slice(currentIdx + 1).find((i) => i.type === "lesson") ?? null;

  const lessonItems = allItems.filter((i) => i.type === "lesson");
  const totalDuration = lessonItems.reduce((sum, { item }) => sum + (item.duration ?? 0), 0);
  const totalLessons = lessonItems.length;

  return {
    course: { ...course, iconSet },
    resources,
    glossary,
    progress,
    quizzesModuleMap,
    activeItem,
    completedLessonIds: Array.from(completedLessonIds),
    userId: user.id,
    prevItem,
    nextItem,
    nextLessonItem,
    totalLessons,
    totalItems: allItems.length,
    currentItemNumber: currentIdx + 1,
    totalDuration,
  };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const courseId = params.courseId!;
  // Same rule as the loader — without this any logged-in user could mark
  // progress / submit quizzes on courses they never bought.
  await requireCourseAccess(user.id, courseId);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_progress") {
    // Only "flat" courses (no lessons/quizzes) track a course-level watch
    // percent. Modular courses derive progress from lessons/quizzes — a single
    // lesson's watch percent must never overwrite the whole course.
    const itemCount = await prisma.lesson.count({ where: { module: { courseId } } });
    if (itemCount > 0)
      return data({ error: "Use complete_lesson for modular courses." }, { status: 400 });

    const percent = Math.min(100, Math.max(0, parseInt(String(formData.get("percent") || "0"), 10) || 0));
    const existing = await prisma.progress.findUnique({
      where: { userId_courseId: { userId: user.id, courseId } },
      select: { completionPercent: true, isCompleted: true, completedAt: true },
    });
    // The server decides completion (>= 95 %), and progress never goes
    // backwards - re-watching from the start must not un-complete the course.
    const newPercent = Math.max(existing?.completionPercent ?? 0, percent);
    const isCompleted = (existing?.isCompleted ?? false) || newPercent >= 95;
    const completedAt = existing?.completedAt ?? (isCompleted ? new Date() : null);
    await prisma.progress.upsert({
      where: { userId_courseId: { userId: user.id, courseId } },
      update: { completionPercent: newPercent, isCompleted, completedAt, lastAccessedAt: new Date() },
      create: { userId: user.id, courseId, completionPercent: newPercent, isCompleted, completedAt },
    });
    return data({ ok: true });
  }

  // Undo an accidental "Mark as complete".
  if (intent === "uncomplete_lesson") {
    const lessonId = formData.get("lessonId") as string;
    const lesson = lessonId
      ? await prisma.lesson.findFirst({
          where: { id: lessonId, module: { courseId } },
          select: { id: true },
        })
      : null;
    if (!lesson)
      return data({ error: "Lesson not found in this course." }, { status: 400 });
    await prisma.lessonProgress.updateMany({
      where: { userId: user.id, lessonId },
      data: { isCompleted: false, completedAt: null },
    });
    await recomputeCourseProgress(user.id, courseId);
    return data({ ok: true });
  }

  if (intent === "complete_lesson") {
    const lessonId = formData.get("lessonId") as string;
    const lesson = lessonId
      ? await prisma.lesson.findFirst({
          where: { id: lessonId, module: { courseId } },
          select: { id: true },
        })
      : null;
    if (!lesson)
      return data({ error: "Lesson not found in this course." }, { status: 400 });
    await prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId: user.id, lessonId } },
      update: { isCompleted: true, completedAt: new Date() },
      create: { userId: user.id, lessonId, isCompleted: true, completedAt: new Date() },
    });
    await recomputeCourseProgress(user.id, courseId);
    return data({ ok: true });
  }

  if (intent === "submit_quiz") {
    const quizId = formData.get("quizId") as string;
    const quizRows = await prisma.$queryRaw<any[]>`
      SELECT q.* FROM "Quiz" q
      JOIN "Module" m ON m.id = q."moduleId"
      WHERE q.id = ${quizId} AND m."courseId" = ${courseId}
    `;
    const quiz = quizRows[0];
    if (!quiz) return data({ error: "Quiz not found" }, { status: 404 });

    // Attempt limit (0 = unlimited). Enforced here, not just displayed.
    const attemptsAllowed = Number(quiz.attemptsAllowed) || 0;
    if (attemptsAllowed > 0) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM "QuizAttempt" WHERE "userId" = ${user.id} AND "quizId" = ${quizId}
      `;
      if (Number(n) >= attemptsAllowed)
        return data({ error: "You have used all attempts for this quiz." }, { status: 403 });
    }

    const questions = await prisma.$queryRaw<any[]>`
      SELECT * FROM "Question" WHERE "quizId" = ${quizId} ORDER BY "order"
    `;
    const allAnswers = questions.length
      ? await prisma.$queryRaw<any[]>`
          SELECT * FROM "Answer"
          WHERE "questionId" IN (${Prisma.join(questions.map((q: any) => q.id))})
          ORDER BY "order", id
        `
      : [];
    const answersByQuestion: Record<string, any[]> = {};
    for (const a of allAnswers) (answersByQuestion[a.questionId] ??= []).push(a);

    const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

    let score = 0;
    let maxScore = 0;
    const questionResults: any[] = [];
    const missingRequired: string[] = [];

    for (const q of questions) {
      const answers = answersByQuestion[q.id] ?? [];
      const points = Number(q.points);
      maxScore += points;
      const type = q.questionType;

      let pointsEarned = 0;
      let isCorrect: boolean | null = null;
      let submittedAnswerId: string | null = null;
      let submittedText: string | null = null;
      let answered = false;

      if (type === "MULTIPLE_CHOICE" || type === "TRUE_FALSE" || type === "IMAGE_ANSWERING" || type === "VIDEO_ANSWERING") {
        const chosen = Array.from(new Set(formData.getAll(`answer_${q.id}`).map(String).filter(Boolean)));
        answered = chosen.length > 0;
        if (type === "MULTIPLE_CHOICE" && q.allowMultiple) {
          // Every correct option and nothing else — otherwise 0.
          const correctIds = answers.filter((a: any) => a.isCorrect).map((a: any) => a.id).sort();
          const chosenSorted = [...chosen].sort();
          isCorrect =
            chosenSorted.length > 0 &&
            chosenSorted.length === correctIds.length &&
            correctIds.every((id: string, i: number) => id === chosenSorted[i]);
          submittedAnswerId = chosenSorted[0] ?? null;
          submittedText = chosenSorted.length
            ? answers.filter((a: any) => chosenSorted.includes(a.id)).map((a: any) => a.text).join(", ")
            : null;
        } else {
          submittedAnswerId = chosen[0] ?? null;
          isCorrect = !!submittedAnswerId && answers.some((a: any) => a.id === submittedAnswerId && a.isCorrect);
        }
      } else if (type === "FILL_BLANK") {
        submittedText = String(formData.get(`answer_${q.id}`) ?? "").trim();
        answered = submittedText !== "";
        const correctTexts = answers.filter((a: any) => a.isCorrect).map((a: any) => norm(a.text));
        isCorrect = answered && correctTexts.includes(norm(submittedText));
      } else if (type === "ESSAY" || type === "SHORT_ANSWER") {
        submittedText = (formData.get(`answer_${q.id}`) as string) || null;
        answered = !!submittedText?.trim();
        isCorrect = null; // needs manual grading
      } else if (type === "MATCHING") {
        // Each left item must be matched to its matchText (case-insensitive).
        const gradable = answers.filter((a: any) => norm(a.matchText) !== "");
        const responses: Record<string, string> = {};
        let matched = 0;
        for (const a of answers) {
          const v = String(formData.get(`answer_${q.id}_${a.id}`) ?? "").trim();
          responses[a.text] = v;
          if (v) answered = true;
          if (norm(a.matchText) !== "" && norm(v) === norm(a.matchText)) matched++;
        }
        submittedText = answered
          ? Object.entries(responses).filter(([, v]) => v).map(([k, v]) => `${k} → ${v}`).join("; ")
          : null;
        // No matchText configured → cannot auto-grade → instructor review.
        isCorrect = gradable.length === 0 ? null : matched === gradable.length;
      } else if (type === "ORDERING") {
        // Expected position = the admin's entry order (Answer.order). Legacy
        // questions where every answer still has order 0 go to manual review.
        const orders = answers.map((a: any) => Number(a.order));
        const gradable = answers.length > 1 && new Set(orders).size === answers.length;
        const responses: Record<string, number | null> = {};
        let allMatch = answers.length > 0;
        answers.forEach((a: any, i: number) => {
          const raw = String(formData.get(`answer_${q.id}_${a.id}`) ?? "").trim();
          const v = raw === "" ? NaN : Number(raw);
          responses[a.text] = Number.isFinite(v) ? v : null;
          if (Number.isFinite(v)) answered = true;
          if (v !== i + 1) allMatch = false;
        });
        submittedText = answered
          ? Object.entries(responses).filter(([, v]) => v !== null).map(([k, v]) => `${v}. ${k}`).join("; ")
          : null;
        isCorrect = gradable ? allMatch : null;
      } else {
        isCorrect = null;
      }

      if (q.answerRequired && !answered) missingRequired.push(q.title);
      if (isCorrect) { pointsEarned = points; score += points; }

      questionResults.push({
        id: q.id,
        title: q.title,
        questionType: type,
        points,
        pointsEarned,
        isCorrect,
        submittedAnswerId,
        submittedText,
        allAnswers: quiz.feedbackMode === "REVEAL"
          ? answers.map((a: any) => ({ id: a.id, text: a.text, isCorrect: a.isCorrect, imageUrl: a.imageUrl }))
          : undefined,
      });
    }

    // A timed quiz that ran out of time is accepted as-is; blanks score 0.
    const timedOut = formData.get("timedOut") === "1" && Number(quiz.timeLimit) > 0;
    if (missingRequired.length && !timedOut)
      return data(
        { error: `Please answer the required question${missingRequired.length > 1 ? "s" : ""}: ${missingRequired.join("; ")}` },
        { status: 400 },
      );

    const passingGrade = Number(quiz.passingGrade);
    const isPassed = maxScore > 0 && (score / maxScore) * 100 >= passingGrade;
    const attemptId = randomUUID();

    await prisma.$executeRaw`
      INSERT INTO "QuizAttempt" (id, "userId", "quizId", score, "maxScore", "isPassed", "submittedAt")
      VALUES (${attemptId}, ${user.id}, ${quizId}, ${score}, ${maxScore}, ${isPassed}, NOW())
    `;

    // Store individual answers
    for (const qr of questionResults) {
      const aaId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "QuizAttemptAnswer" (id, "attemptId", "questionId", "answerId", "answerText", "isCorrect", "pointsEarned")
        VALUES (${aaId}, ${attemptId}, ${qr.id}, ${qr.submittedAnswerId}, ${qr.submittedText}, ${qr.isCorrect}, ${qr.pointsEarned})
      `;
    }

    // A passed quiz counts toward course completion, same as a lesson.
    if (isPassed) await recomputeCourseProgress(user.id, courseId);

    const pending = questionResults.some((qr) => qr.isCorrect === null);
    // DEFAULT feedback mode shows only the score — never per-question
    // correctness, which would let learners brute-force answers over retakes.
    const visibleResults = quiz.feedbackMode === "DEFAULT" ? [] : questionResults;

    return data({
      ok: true, score, maxScore, isPassed, pending, passingGrade,
      feedbackMode: quiz.feedbackMode, attemptId, questionResults: visibleResults,
    });
  }

  return { ok: true };
}

// ── AnswerVideo ───────────────────────────────────────────────────────────────

function AnswerVideo({ videoUrl }: { videoUrl: string }) {
  const embed = resolveVideoEmbed(videoUrl);
  return (
    <div className="mt-2 rounded-xl overflow-hidden border border-blue-200 shadow-sm">
      {embed.type === "hls" ? (
        <HlsPlayer src={embed.src} autoPlay className="w-full max-h-56" />
      ) : embed.type === "direct" ? (
        <video src={embed.src} controls autoPlay playsInline className="w-full max-h-56 bg-black" />
      ) : (
        <iframe
          src={`${embed.src}${embed.src.includes("?") ? "&" : "?"}autoplay=1`}
          className="w-full aspect-video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
    </div>
  );
}

// ── QuestionBlock ─────────────────────────────────────────────────────────────

/** Deterministic shuffle so a question's option order is stable across re-renders. */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function QuestionBlock({
  question,
  index,
  value,
  onChange,
}: {
  question: any;
  index: number;
  value: string | string[];
  onChange: (v: string | string[]) => void;
}) {
  const type = question.questionType;
  const rawAnswers: any[] = question.answers || [];
  // ORDERING must never display answers in their correct order; other types
  // shuffle only when the admin asked for it.
  const answers: any[] = useMemo(
    () => (type === "ORDERING" || question.randomizeAnswers ? seededShuffle(rawAnswers, question.id) : rawAnswers),
    [rawAnswers, type, question.randomizeAnswers, question.id],
  );
  const multi = type === "MULTIPLE_CHOICE" && !!question.allowMultiple;
  const selected: string[] = Array.isArray(value) ? value : value ? [value] : [];
  const toggle = (id: string) =>
    multi
      ? onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
      : onChange(id);
  const [tfRevealed, setTfRevealed] = useState(false);

  const handleTfSelect = (answerId: string) => {
    if (tfRevealed) return;
    onChange(answerId);
    setTfRevealed(true);
  };

  return (
    <div className="border border-gray-200 rounded-xl p-5 mb-4 bg-white">
      <div className="flex items-start gap-3 mb-4">
        <span className="shrink-0 w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center mt-0.5">
          {index + 1}
        </span>
        <p className="text-gray-800 text-sm leading-relaxed flex-1">{question.title}</p>
        <span className="shrink-0 flex items-center gap-1.5">
          {question.answerRequired && (
            <span className="text-[11px] font-semibold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full">Required</span>
          )}
          <span className="text-[12px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            {Number(question.points)} pt{Number(question.points) !== 1 ? "s" : ""}
          </span>
        </span>
      </div>

      {type === "TRUE_FALSE" && (
        <div className="space-y-2 pl-10">
          {answers.filter((a: any, i: number, arr: any[]) =>
            arr.findIndex((x: any) => x.text === a.text) === i
          ).slice(0, 2).map((a: any) => {
            const isSelected = selected[0] === a.id;
            const isCorrect = a.isCorrect === true;
            let rowClass = "border-gray-200 hover:border-gray-300 hover:bg-gray-50 cursor-pointer";
            let radioClass = "border-gray-300";
            let icon: React.ReactNode = null;

            if (tfRevealed) {
              if (isSelected && isCorrect) {
                rowClass = "border-green-500 bg-green-50 cursor-default";
                radioClass = "border-green-600 bg-green-600";
                icon = <Check size={15} className="text-green-600 shrink-0" />;
              } else if (isSelected && !isCorrect) {
                rowClass = "border-red-400 bg-red-50 cursor-default";
                radioClass = "border-red-500 bg-red-500";
                icon = <X size={15} className="text-red-500 shrink-0" />;
              } else if (!isSelected && isCorrect) {
                rowClass = "border-green-400 bg-green-50 cursor-default";
                radioClass = "border-green-500 bg-green-500";
                icon = <Check size={15} className="text-green-500 shrink-0" />;
              } else {
                rowClass = "border-gray-200 bg-gray-50 opacity-60 cursor-default";
              }
            } else if (isSelected) {
              rowClass = "border-blue-500 bg-blue-50 cursor-pointer";
              radioClass = "border-blue-600 bg-blue-600";
            }

            return (
              <button
                key={a.id}
                type="button"
                onClick={() => handleTfSelect(a.id)}
                disabled={tfRevealed}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${rowClass}`}
              >
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${radioClass}`}>
                  {(isSelected || (tfRevealed && isCorrect)) && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
                <input type="radio" name={`answer_${question.id}`} value={a.id} checked={isSelected} onChange={() => handleTfSelect(a.id)} className="sr-only" />
                <span className="text-sm text-gray-700 flex-1 font-medium">{a.text}</span>
                {icon}
              </button>
            );
          })}
          {tfRevealed && (
            <p className={`text-xs font-semibold pt-1 ${answers.find((a: any) => a.id === value)?.isCorrect ? "text-green-600" : "text-red-500"}`}>
              {answers.find((a: any) => a.id === value)?.isCorrect
                ? "Correct!"
                : "Incorrect — the correct answer is highlighted above."}
            </p>
          )}
          {value && (() => {
            const sel = answers.find((a: any) => a.id === value);
            return sel?.videoUrl ? <AnswerVideo videoUrl={sel.videoUrl} /> : null;
          })()}
        </div>
      )}

      {(type === "MULTIPLE_CHOICE" || type === "IMAGE_ANSWERING") && (
        <div className="space-y-2 pl-10">
          {multi && <p className="text-xs text-gray-500 mb-1">Select all that apply.</p>}
          {answers.map((a: any) => {
            const isSelected = selected.includes(a.id);
            return (
              <div key={a.id}>
                <label
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  <div
                    className={`w-4 h-4 ${multi ? "rounded" : "rounded-full"} border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? "border-blue-600 bg-blue-600" : "border-gray-300"
                    }`}
                  >
                    {isSelected && (multi ? <Check size={10} className="text-white" strokeWidth={3} /> : <div className="w-1.5 h-1.5 rounded-full bg-white" />)}
                  </div>
                  <input type={multi ? "checkbox" : "radio"} name={`answer_${question.id}`} value={a.id} checked={isSelected} onChange={() => toggle(a.id)} className="sr-only" />
                  <div className="flex-1">
                    {type === "IMAGE_ANSWERING" && a.imageUrl && (
                      <img src={a.imageUrl} alt="" className="w-28 h-20 object-cover rounded mb-2" />
                    )}
                    <span className="text-sm text-gray-700">{a.text}</span>
                  </div>
                  {a.videoUrl && !isSelected && <Play size={13} className="text-gray-400 shrink-0" />}
                </label>
                {isSelected && a.videoUrl && <AnswerVideo videoUrl={a.videoUrl} />}
              </div>
            );
          })}
        </div>
      )}

      {type === "VIDEO_ANSWERING" && (
        <div className="space-y-3 pl-10">
          {answers.map((a: any) => {
            const isSelected = selected[0] === a.id;
            const embed = isSelected && a.videoUrl ? resolveVideoEmbed(a.videoUrl) : null;
            return (
              <div key={a.id}>
                <button
                  type="button"
                  onClick={() => onChange(a.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                    isSelected
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50 cursor-pointer"
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? "border-blue-600 bg-blue-600" : "border-gray-300"
                    }`}
                  >
                    {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                  <input type="radio" name={`answer_${question.id}`} value={a.id} checked={isSelected} onChange={() => onChange(a.id)} className="sr-only" />
                  <span className="text-sm text-gray-700 flex-1">{a.text}</span>
                  {a.videoUrl && !isSelected && <Play size={13} className="text-gray-400 shrink-0" />}
                </button>
                {isSelected && embed && (
                  <div className="mt-2 rounded-xl overflow-hidden border border-blue-200 shadow-sm">
                    {embed.type === "direct" ? (
                      <video src={embed.src} controls autoPlay className="w-full max-h-56 bg-black" />
                    ) : (
                      <iframe
                        src={`${embed.src}${embed.src.includes("?") ? "&" : "?"}autoplay=1`}
                        className="w-full aspect-video"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    )}
                  </div>
                )}
                {isSelected && !a.videoUrl && (
                  <div className="mt-2 rounded-xl border border-blue-200 bg-gray-100 h-24 flex items-center justify-center text-gray-400 text-sm">
                    No video attached
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(type === "SHORT_ANSWER" || type === "FILL_BLANK") && (
        <div className="pl-10">
          <input
            type="text"
            name={`answer_${question.id}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder={type === "FILL_BLANK" ? "Fill in the blank..." : "Your answer..."}
          />
        </div>
      )}

      {type === "ESSAY" && (
        <div className="pl-10">
          <textarea
            name={`answer_${question.id}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={5}
            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-y"
            placeholder="Write your answer here..."
          />
        </div>
      )}

      {type === "MATCHING" && (
        <div className="pl-10 space-y-2">
          <p className="text-xs text-gray-500 mb-3">Match each item on the left with the correct item on the right.</p>
          {answers.map((a: any) => (
            <div key={a.id} className="flex items-center gap-3">
              <div className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-gray-50">{a.text}</div>
              <span className="text-gray-400">→</span>
              {Array.isArray(question.matchOptions) && question.matchOptions.length > 0 ? (
                <select
                  name={`answer_${question.id}_${a.id}`}
                  defaultValue=""
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">Choose…</option>
                  {question.matchOptions.map((opt: string) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  name={`answer_${question.id}_${a.id}`}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-blue-500"
                  placeholder="Match..."
                />
              )}
            </div>
          ))}
        </div>
      )}

      {type === "ORDERING" && (
        <div className="pl-10 space-y-2">
          <p className="text-xs text-gray-500 mb-3">Enter the correct order (1, 2, 3...) for each item.</p>
          {answers.map((a: any) => (
            <div key={a.id} className="flex items-center gap-3">
              <input
                type="number"
                name={`answer_${question.id}_${a.id}`}
                min={1}
                max={answers.length}
                className="w-16 border border-gray-300 rounded-lg px-2 py-2 text-sm text-center text-gray-800 focus:outline-none focus:border-blue-500"
                placeholder="#"
              />
              <div className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-gray-50">{a.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confetti ──────────────────────────────────────────────────────────────────

const CONFETTI_PIECES = Array.from({ length: 50 }, (_, i) => ({
  left: `${(i * 37 + 11) % 100}%`,
  delay: `${((i * 0.13) % 2).toFixed(2)}s`,
  duration: `${(2.2 + (i * 0.17) % 1.8).toFixed(2)}s`,
  color: ["#10b981","#3b82f6","#f59e0b","#8b5cf6","#ef4444","#06b6d4","#f472b6"][i % 7],
  size: `${7 + (i % 5)}px`,
  shape: i % 3 === 0 ? "50%" : "2px",
}));

function Confetti() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-50">
      <style>{`
        @keyframes cf-fall {
          0%   { transform: translateY(-30px) rotate(0deg); opacity: 1; }
          80%  { opacity: 1; }
          100% { transform: translateY(105vh) rotate(540deg); opacity: 0; }
        }
      `}</style>
      {CONFETTI_PIECES.map((p, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: p.left,
            top: 0,
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: p.shape,
            animation: `cf-fall ${p.duration} ${p.delay} ease-in forwards`,
          }}
        />
      ))}
    </div>
  );
}

// ── ScoreArc ──────────────────────────────────────────────────────────────────

function ScoreArc({ pct, isPassed }: { pct: number; isPassed: boolean }) {
  const [animPct, setAnimPct] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setAnimPct(pct), 80);
    return () => clearTimeout(t);
  }, [pct]);

  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animPct / 100) * circumference;
  const color = isPassed ? "#10b981" : "#ef4444";

  return (
    <div className="relative w-36 h-36">
      <svg className="w-36 h-36 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="11" />
        <circle
          cx="60" cy="60" r={radius} fill="none"
          stroke={color}
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black text-gray-900">{pct}%</span>
        <span className="text-[13px] text-gray-400 mt-0.5">Score</span>
      </div>
    </div>
  );
}

// ── QuestionReviewCard ─────────────────────────────────────────────────────────

function QuestionReviewCard({ qr, idx, feedbackMode }: { qr: any; idx: number; feedbackMode: string }) {
  const isPending = qr.isCorrect === null;
  const isCorrect = qr.isCorrect === true;

  let borderCls = "border-gray-200 bg-white";
  let dotCls = "bg-gray-400";
  let dotLabel = "?";
  if (!isPending) {
    if (isCorrect) { borderCls = "border-green-200 bg-green-50"; dotCls = "bg-green-500"; dotLabel = "✓"; }
    else           { borderCls = "border-red-200 bg-red-50";    dotCls = "bg-red-500";   dotLabel = "✗"; }
  }

  return (
    <div className={`rounded-xl border p-4 ${borderCls}`}>
      <div className="flex items-start gap-3 mb-2">
        <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white text-[13px] font-bold mt-0.5 ${dotCls}`}>
          {dotLabel}
        </div>
        <p className="text-sm text-gray-800 flex-1 font-medium">{idx + 1}. {qr.title}</p>
        <span className="text-xs text-gray-500 shrink-0 font-medium">{qr.pointsEarned}/{qr.points} pt</span>
      </div>

      {qr.submittedText && (
        <div className="ml-9 text-xs text-gray-600 bg-white rounded-lg border border-gray-200 px-3 py-2 mb-2">
          Your answer: <span className="font-medium">{qr.submittedText}</span>
        </div>
      )}

      {feedbackMode === "REVEAL" && qr.allAnswers && (
        <div className="ml-9 space-y-1">
          {qr.allAnswers.map((a: any) => (
            <div key={a.id} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${a.isCorrect ? "bg-green-100 text-green-800 font-semibold" : "text-gray-500"}`}>
              {a.isCorrect
                ? <Check size={11} className="text-green-600 shrink-0" />
                : <div className="w-2.5 h-2.5 rounded-full bg-gray-200 shrink-0" />}
              {a.text}
            </div>
          ))}
        </div>
      )}

      {isPending && (
        <p className="ml-9 text-xs text-amber-600 italic mt-1">⏳ Pending instructor review</p>
      )}
    </div>
  );
}

// ── QuizAttemptForm ───────────────────────────────────────────────────────────

function QuizAttemptForm({ quiz, onRetake }: { quiz: any; onRetake: () => void }) {
  const quizFetcher = useFetcher<{
    ok?: boolean; error?: string; score?: number; maxScore?: number; isPassed?: boolean; pending?: boolean;
    passingGrade?: number; feedbackMode?: string; attemptId?: string; questionResults?: any[];
  }>();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const attemptsAllowed = Number(quiz.attemptsAllowed) || 0;
  const attemptsUsed = Number(quiz.attemptCount) || 0;
  const attemptsLeft = attemptsAllowed > 0 ? Math.max(0, attemptsAllowed - attemptsUsed) : Infinity;
  const [timeLeft, setTimeLeft] = useState<number | null>(
    Number(quiz.timeLimit) > 0 ? Number(quiz.timeLimit) * 60 : null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = quizFetcher.data?.ok;
  const result = quizFetcher.data;
  const questions: any[] = quiz.questions || [];

  useEffect(() => {
    if (!timeLeft || submitted) return;
    const t = setInterval(() => setTimeLeft((p) => (p !== null && p > 0 ? p - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [submitted]);

  useEffect(() => {
    if (timeLeft === 0 && !submitted) {
      // Time is up: submit what exists, even if a required question is blank.
      const flag = document.createElement("input");
      flag.type = "hidden"; flag.name = "timedOut"; flag.value = "1";
      formRef.current?.appendChild(flag);
      formRef.current?.requestSubmit();
    }
  }, [timeLeft, submitted]);

  if (submitted && result) {
    const pct = result.maxScore! > 0 ? Math.floor((result.score! / result.maxScore!) * 100) : 0;
    const isPassed = !!result.isPassed;
    const isPending = !!result.pending && !isPassed;
    const feedbackMode = result.feedbackMode ?? "DEFAULT";
    const hasReview = (feedbackMode === "REVEAL" || feedbackMode === "RETRY") && Array.isArray(result.questionResults) && result.questionResults.length > 0;

    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        {isPassed && <Confetti />}

        {/* Score Arc */}
        <div className="flex flex-col items-center mb-8">
          <ScoreArc pct={pct} isPassed={isPassed} />

          <div className={`mt-5 inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold border ${
            isPassed ? "bg-green-50 text-green-700 border-green-200"
              : isPending ? "bg-amber-50 text-amber-700 border-amber-200"
              : "bg-red-50 text-red-600 border-red-200"
          }`}>
            {isPassed ? <><Trophy size={14} /> Quiz Passed!</>
              : isPending ? <><AlertCircle size={14} /> Awaiting instructor review</>
              : <><AlertCircle size={14} /> Quiz Failed</>}
          </div>

          <p className="text-gray-500 text-sm mt-3">
            <span className="font-semibold text-gray-800">{result.score} / {result.maxScore}</span> points &nbsp;·&nbsp; Passing grade: {result.passingGrade}%
          </p>

          {!isPassed && !isPending && (
            <p className="text-gray-400 text-xs mt-1">You need {result.passingGrade}% or higher to pass.</p>
          )}

          {result.pending && (
            <div className="mt-3 flex items-center gap-2 text-amber-600 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle size={12} />
              Some answers require instructor review. Your score may change.
            </div>
          )}
        </div>

        {/* Answer Review */}
        {hasReview && (
          <div className="mb-8 space-y-3">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <CheckCircle2 size={15} className="text-blue-500" />
              Answer Review
            </h3>
            {result.questionResults!.map((qr: any, idx: number) => (
              <QuestionReviewCard key={qr.id} qr={qr} idx={idx} feedbackMode={feedbackMode} />
            ))}
          </div>
        )}

        {/* Retake — only while attempts remain (loader revalidates attemptCount after submit) */}
        <div className="flex flex-col items-center gap-2">
          {attemptsLeft > 0 ? (
            <button
              onClick={onRetake}
              className="flex items-center gap-2 border border-gray-300 hover:border-gray-400 text-gray-700 hover:text-gray-900 bg-white px-6 py-2.5 rounded-xl transition-colors text-sm font-medium shadow-sm"
            >
              <RefreshCw size={14} /> Retake Quiz
            </button>
          ) : (
            <p className="text-xs text-gray-400">No attempts remaining.</p>
          )}
          {attemptsAllowed > 0 && attemptsLeft > 0 && attemptsLeft !== Infinity && (
            <p className="text-xs text-gray-400">{attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-2">
          <h1 className="text-xl font-bold text-gray-900">{quiz.title}</h1>
          {timeLeft !== null && !quiz.hideQuizTime && (
            <div className={`flex items-center gap-1.5 text-sm font-mono font-semibold px-3 py-1.5 rounded-lg border shrink-0 ${
              timeLeft < 60 ? "text-red-600 bg-red-50 border-red-200" : "text-blue-600 bg-blue-50 border-blue-200"
            }`}>
              <Timer size={13} />{formatCountdown(timeLeft)}
            </div>
          )}
        </div>
        {quiz.summary && <p className="text-gray-500 text-sm">{quiz.summary}</p>}
        <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
          <span>{questions.length} question{questions.length !== 1 ? "s" : ""}</span>
          <span>Passing grade: {quiz.passingGrade}%</span>
          {attemptsAllowed > 0 && <span>Attempts: {attemptsUsed} / {attemptsAllowed}</span>}
        </div>
        {quiz.latestAttempt && (
          <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg border text-sm ${
            quiz.latestAttempt.isPassed
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-red-50 border-red-200 text-red-600"
          }`}>
            {quiz.latestAttempt.isPassed ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            <span>
              Last attempt:{" "}
              {quiz.latestAttempt.maxScore > 0
                ? Math.round((quiz.latestAttempt.score / quiz.latestAttempt.maxScore) * 100)
                : 0}%{quiz.latestAttempt.isPassed ? " — Passed" : " — Failed"}
            </span>
          </div>
        )}
      </div>

      {questions.length === 0 ? (
        <div className="text-center py-16 border border-gray-200 rounded-xl">
          <HelpCircle size={40} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-400">This quiz has no questions yet.</p>
        </div>
      ) : attemptsLeft <= 0 ? (
        <div className="text-center py-16 border border-gray-200 rounded-xl">
          <AlertCircle size={40} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">You have used all {attemptsAllowed} attempts for this quiz.</p>
          {quiz.hasPassed && <p className="text-green-600 text-sm mt-1">You already passed — nice work.</p>}
        </div>
      ) : (
        <quizFetcher.Form method="post" ref={formRef}>
          <input type="hidden" name="intent" value="submit_quiz" />
          <input type="hidden" name="quizId" value={quiz.id} />
          {quizFetcher.data?.error && (
            <div className="mb-4 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <AlertCircle size={14} className="shrink-0" /> {quizFetcher.data.error}
            </div>
          )}
          {questions.map((q: any, idx: number) => (
            <QuestionBlock
              key={q.id}
              question={q}
              index={idx}
              value={answers[q.id] ?? (q.allowMultiple ? [] : "")}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
            />
          ))}
          <div className="flex justify-end mt-6 pb-4">
            <button
              type="submit"
              disabled={quizFetcher.state !== "idle"}
              className="flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark disabled:opacity-60 text-white font-semibold px-8 py-3 rounded-xl transition-colors shadow-md"
            >
              {quizFetcher.state !== "idle" ? (
                <><RefreshCw size={15} className="animate-spin" /> Submitting...</>
              ) : (
                <><CheckCircle2 size={15} /> Submit Quiz</>
              )}
            </button>
          </div>
        </quizFetcher.Form>
      )}
    </div>
  );
}

function QuizPlayer({ quiz }: { quiz: any }) {
  const [attemptKey, setAttemptKey] = useState(0);
  return <QuizAttemptForm key={attemptKey} quiz={quiz} onRetake={() => setAttemptKey((k) => k + 1)} />;
}


// -- Glossary / Resources drawer ----------------------------------------------

type DrawerResource = {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  lessonId: string | null;
  fileName: string | null;
  fileSize: number | null;
};

function drawerBytes(n: number | null) {
  if (!n) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function CourseDrawer({
  open,
  onClose,
  resources,
  glossary,
  lessonTitles,
}: {
  open: null | "glossary" | "resources";
  onClose: () => void;
  resources: DrawerResource[];
  glossary: Array<{ id: string; term: string; definition: string }>;
  lessonTitles: Record<string, string>;
}) {
  const [q, setQ] = useState("");

  // Reset the filter each time the drawer is opened, and let Escape close it.
  useEffect(() => {
    if (!open) return;
    setQ("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const terms = needle
    ? glossary.filter(
        (t) =>
          t.term.toLowerCase().includes(needle) ||
          t.definition.toLowerCase().includes(needle),
      )
    : glossary;
  const files = needle
    ? resources.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          (r.description ?? "").toLowerCase().includes(needle),
      )
    : resources;

  const isGlossary = open === "glossary";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={isGlossary ? "Glossary" : "Resources"}
        className="relative w-full max-w-md h-full flex flex-col shadow-2xl"
        style={{ background: HEADER_BG }}
      >
        <div
          className="flex items-center gap-2 px-5 h-16 shrink-0 border-b"
          style={{ borderColor: "rgba(0,26,56,0.10)" }}
        >
          {isGlossary ? (
            <BookMarked size={18} style={{ color: ACTIVE_FG }} />
          ) : (
            <Paperclip size={18} style={{ color: ACTIVE_FG }} />
          )}
          <h2 className="font-semibold text-[17px]" style={{ color: ACTIVE_FG }}>
            {isGlossary ? "Glossary" : "Resources"}
          </h2>
          <span className="text-[13px]" style={{ color: "rgba(0,26,56,0.5)" }}>
            ({isGlossary ? glossary.length : resources.length})
          </span>
          <button
            onClick={onClose}
            title="Close"
            className="ml-auto p-1.5 rounded hover:bg-black/5 transition-colors"
            style={{ color: "rgba(0,26,56,0.6)" }}
          >
            <X size={18} />
          </button>
        </div>

        {(isGlossary ? glossary.length : resources.length) > 6 && (
          <div className="px-5 pt-4 shrink-0">
            <div className="relative">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: "rgba(0,26,56,0.4)" }}
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={isGlossary ? "Search terms\u2026" : "Search resources\u2026"}
                className="w-full rounded-lg bg-white py-2 pl-9 pr-3 text-sm focus:outline-none"
                style={{ border: "1px solid rgba(0,26,56,0.18)", color: ACTIVE_FG }}
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isGlossary ? (
            terms.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: "rgba(0,26,56,0.5)" }}>
                No matching terms.
              </p>
            ) : (
              <dl className="space-y-4">
                {terms.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-xl bg-white p-4"
                    style={{ border: "1px solid rgba(0,26,56,0.10)" }}
                  >
                    <dt className="font-semibold text-[15px]" style={{ color: ACTIVE_FG }}>
                      {t.term}
                    </dt>
                    <dd
                      className="text-sm mt-1 leading-relaxed"
                      style={{ color: "rgba(0,26,56,0.72)" }}
                    >
                      {t.definition}
                    </dd>
                  </div>
                ))}
              </dl>
            )
          ) : files.length === 0 ? (
            <p className="text-sm py-8 text-center" style={{ color: "rgba(0,26,56,0.5)" }}>
              No matching resources.
            </p>
          ) : (
            <ul className="space-y-3">
              {files.map((r) => {
                const isLink = r.kind === "LINK";
                const size = drawerBytes(r.fileSize);
                const where = r.lessonId ? lessonTitles[r.lessonId] : null;
                return (
                  <li key={r.id}>
                    {/* Always /student/resource/<id>: the request re-checks the
                        licence, so the storage URL never reaches the page. */}
                    <a
                      href={`/student/resource/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 rounded-xl bg-white p-4 hover:shadow-sm transition-shadow"
                      style={{ border: "1px solid rgba(0,26,56,0.10)" }}
                    >
                      <span
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: "rgba(198,148,69,0.15)", color: "#8a6320" }}
                      >
                        {isLink ? <Link2 size={16} /> : <FileText size={16} />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span
                          className="block font-semibold text-[15px] leading-tight"
                          style={{ color: ACTIVE_FG }}
                        >
                          {r.title}
                        </span>
                        {r.description && (
                          <span
                            className="block text-xs mt-0.5"
                            style={{ color: "rgba(0,26,56,0.6)" }}
                          >
                            {r.description}
                          </span>
                        )}
                        <span
                          className="block text-[11px] mt-1 truncate"
                          style={{ color: "rgba(0,26,56,0.45)" }}
                        >
                          {where ?? "Whole course"}
                          {size ? ` \u00b7 ${size}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 pt-1" style={{ color: "rgba(0,26,56,0.5)" }}>
                        {isLink ? <ExternalLink size={15} /> : <Download size={15} />}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── CourseViewer ──────────────────────────────────────────────────────────────

export default function CourseViewer() {
  const {
    course,
    resources,
    glossary,
    progress,
    quizzesModuleMap,
    activeItem,
    completedLessonIds,
    prevItem,
    nextItem,
    nextLessonItem,
    totalLessons,
    totalItems,
    currentItemNumber,
    totalDuration,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [drawer, setDrawer] = useState<null | "glossary" | "resources">(null);

  // lessonId -> "Module > Lesson", so a resource attached to a lesson can say
  // where it belongs without another round-trip.
  const lessonTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of course.modules) {
      for (const l of m.lessons) map[l.id] = `${m.title} \u203a ${l.title}`;
    }
    return map;
  }, [course.modules]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // True accordion: exactly one module open at a time. Opens on the module
  // that holds the lesson/quiz being viewed.
  const [openModuleId, setOpenModuleId] = useState<string | null>(
    () => activeItem?.module?.id ?? course.modules[0]?.id ?? null,
  );

  const completedSet = new Set(completedLessonIds);
  const completionPercent = progress?.completionPercent ?? 0;
  const isCompleted = progress?.isCompleted ?? false;

  const currentLesson = activeItem?.type === "lesson" ? activeItem.item : null;
  const currentQuiz = activeItem?.type === "quiz" ? activeItem.item : null;

  const hasModules = course.modules.length > 0 && totalItems > 0;

  const isStoryline =
    currentLesson?.lessonType === "STORYLINE" ||
    (!hasModules && course.contentType === "STORYLINE");
  // iframeEmbed takes priority over videoUrl when present
  const iframeEmbed = currentLesson?.iframeEmbed || null;
  const videoUrl = iframeEmbed ? null : (currentLesson?.videoUrl || (!hasModules ? course.videoUrl : null));
  const embedUrl = currentLesson?.embedUrl || (!hasModules ? course.embedUrl : null);
  const videoSrc = iframeEmbed ? resolveVideoEmbed(iframeEmbed) : (videoUrl ? resolveVideoEmbed(videoUrl) : null);
  const isIframeVideo = videoSrc && (videoSrc.type === "youtube" || videoSrc.type === "vimeo" || videoSrc.type === "iframe");
  const isHlsVideo = videoSrc && videoSrc.type === "hls";
  const isDirectVideo = videoSrc && videoSrc.type === "direct";

  // Completed lessons in THIS course only - the header's "n of m" count.
  const completedCount = course.modules
    .flatMap((m: any) => m.lessons)
    .filter((l: any) => completedSet.has(l.id)).length;

  const markLessonComplete = (lessonId: string) => {
    const fd = new FormData();
    fd.append("intent", "complete_lesson");
    fd.append("lessonId", lessonId);
    fetcher.submit(fd, { method: "post" });
  };

  const markLessonIncomplete = (lessonId: string) => {
    lessonDoneRef.current = null; // allow the watch handler to re-complete later
    const fd = new FormData();
    fd.append("intent", "uncomplete_lesson");
    fd.append("lessonId", lessonId);
    fetcher.submit(fd, { method: "post" });
  };

  // Flat (no-module) courses report a course-level watch percent; modular
  // courses mark the current lesson complete instead. One submission per
  // lesson - the server derives the course percent from all lessons/quizzes.
  const lessonDoneRef = useRef<string | null>(null);
  // Storyline tells us when the learner reaches the last slide of the scene
  // (postMessage { action: "lessonComplete" }). Until then "Next Lesson" stays
  // hidden so nobody skips half a lesson. Non-Storyline lessons are always ready.
  const [reachedLessonEnd, setReachedLessonEnd] = useState(false);
  useEffect(() => {
    setReachedLessonEnd(false);
  }, [currentLesson?.id, currentQuiz?.id]);
  // Latest values readable from long-lived event handlers without making
  // them effect dependencies (a re-subscribe would reset the 5 % throttle).
  const completedSetRef = useRef(completedSet);
  completedSetRef.current = completedSet;
  const currentLessonIdRef = useRef<string | null>(currentLesson?.id ?? null);
  currentLessonIdRef.current = currentLesson?.id ?? null;
  const lastReportedRef = useRef(0);

  const reportWatchProgress = (pct: number) => {
    if (hasModules) {
      const id = currentLessonIdRef.current;
      if (!id || pct < 95) return;
      if (completedSetRef.current.has(id) || lessonDoneRef.current === id) return;
      lessonDoneRef.current = id;
      markLessonComplete(id);
      return;
    }
    const fd = new FormData();
    fd.append("intent", "update_progress");
    fd.append("percent", String(pct));
    fetcher.submit(fd, { method: "post" });
  };

  // Storyline postMessage - only trust messages from OUR iframe, from the
  // origin we embedded. Anything else (another tab, a hostile page holding a
  // reference to this window) is ignored.
  useEffect(() => {
    if (!isStoryline) return;
    let allowedOrigin: string | null = null;
    try {
      allowedOrigin = embedUrl ? new URL(embedUrl, window.location.origin).origin : null;
    } catch { allowedOrigin = null; }
    const handler = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      try {
        const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (msg?.type === "progress" && typeof msg.percent === "number") {
          reportWatchProgress(Math.round(msg.percent));
        }
        // Final slide of the Storyline scene reached.
        if (msg?.action === "lessonComplete" || msg?.type === "lessonComplete") {
          setReachedLessonEnd(true);
        }
      } catch { /* non-JSON */ }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStoryline, embedUrl, hasModules, currentLesson?.id]);

  // Video timeupdate
  useEffect(() => {
    if (isStoryline) return;
    const video = videoRef.current;
    if (!video) return;
    lastReportedRef.current = 0;
    const onTimeUpdate = () => {
      if (!video.duration) return;
      const pct = Math.round((video.currentTime / video.duration) * 100);
      if (Math.abs(pct - lastReportedRef.current) >= 5) {
        lastReportedRef.current = pct;
        reportWatchProgress(pct);
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStoryline, hasModules, currentLesson?.id]);

  const toggleFullscreen = () => {
    const el = (iframeRef.current ?? videoRef.current)?.parentElement;
    if (!document.fullscreenElement && el) {
      el.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  const toggleModule = (id: string) =>
    setOpenModuleId((current) => (current === id ? null : id));

  // Follow navigation: opening a lesson from elsewhere expands its module.
  useEffect(() => {
    if (activeItem?.module?.id) setOpenModuleId(activeItem.module.id);
  }, [activeItem?.module?.id]);

  const itemNavUrl = (item: { type: string; item: any } | null) => {
    if (!item) return "#";
    return item.type === "lesson"
      ? `/student/course/${course.id}?lesson=${item.item.id}`
      : `/student/course/${course.id}?quiz=${item.item.id}`;
  };

  const isLessonDone = currentLesson ? completedSet.has(currentLesson.id) : false;

  return (
    <div className="h-screen flex overflow-hidden bg-brand-navy-deeper">

      {/* ── Sidebar ────────────────────────────────────────────────────────────── */}
      {hasModules && (
        <aside
          className="w-[360px] shrink-0 flex flex-col overflow-hidden"
          style={{ background: "var(--color-brand-navy-deeper)" }}
        >
          {/* Module list */}
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.2) transparent" }}
          >
            {course.modules.map((module: any, moduleIdx: number) => {
              const expanded = openModuleId === module.id;
              const moduleLessons: any[] = module.lessons;
              const moduleQuizzes: any[] = quizzesModuleMap[module.id] || [];
              const totalInModule = moduleLessons.length + moduleQuizzes.length;

              const moduleItems = [
                ...moduleLessons.map((l: any) => ({
                  type: "lesson" as const, item: l, order: Number(l.order),
                })),
                ...moduleQuizzes.map((q: any) => ({
                  type: "quiz" as const, item: q, order: Number(q.order),
                })),
              ].sort((a, b) => a.order - b.order);

              return (
                <div key={module.id} className="mb-1">
                  {/* Module header */}
                  <button
                    onClick={() => toggleModule(module.id)}
                    aria-expanded={expanded}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors"
                    style={{ background: "var(--color-brand-navy-deeper)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--color-brand-navy-deeper)")}
                  >
                    {(() => {
                      // Module 1 of a course is the intro / "Getting Started"
                      // section, so it gets the dedicated icon.
                      const src =
                        moduleIdx === 0
                          ? (moduleIcon(course.iconSet, 0) ?? GETTING_STARTED_ICON)
                          : moduleIcon(course.iconSet, moduleIdx);
                      return src ? (
                        <img src={src} alt="" aria-hidden="true" className="w-[22px] h-[22px] object-contain shrink-0" />
                      ) : (
                        <BookOpen size={20} className="shrink-0" style={{ color: "#7FB3E8" }} />
                      );
                    })()}
                    <p className="flex-1 min-w-0 font-bold text-white text-[16px] leading-snug">
                      {module.title}
                    </p>
                    {expanded
                      ? <ChevronUp size={16} className="shrink-0" style={{ color: "rgba(255,255,255,0.55)" }} />
                      : <ChevronDown size={16} className="shrink-0" style={{ color: "rgba(255,255,255,0.55)" }} />}
                  </button>

                  {/* Item list */}
                  {expanded && (
                    <div>
                      {moduleItems.map((entry, entryIdx) => {
                        if (entry.type === "lesson") {
                          const lesson = entry.item;
                          const isDone = completedSet.has(lesson.id);
                          const isActive = currentLesson?.id === lesson.id;

                          return (
                            <Link
                              key={`lesson-${lesson.id}`}
                              to={`/student/course/${course.id}?lesson=${lesson.id}`}
                              className="flex items-center gap-3 px-4 py-3 transition-colors group"
                              style={{
                                borderBottom: "1px solid rgba(255,255,255,0.05)",
                                background: isActive ? ACTIVE_BG : undefined,
                              }}
                              onMouseEnter={(e) => {
                                if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isActive) e.currentTarget.style.background = "";
                              }}
                            >
                              {/* Status: green tick when done, play icon otherwise */}
                              {isDone ? (
                                <span
                                  className="shrink-0 w-[26px] h-[26px] rounded-full flex items-center justify-center"
                                  style={{ background: "#22c55e" }}
                                >
                                  <Check size={14} className="text-white" strokeWidth={3} />
                                </span>
                              ) : (
                                <PlayCircle
                                  size={26}
                                  strokeWidth={1.75}
                                  className="shrink-0"
                                  style={{ color: isActive ? ACTIVE_FG : "#ffffff" }}
                                />
                              )}

                              {/* Title */}
                              <p
                                className="flex-1 text-[15px] leading-snug min-w-0"
                                style={{
                                  color: isActive ? ACTIVE_FG : "rgba(255,255,255,0.85)",
                                  fontWeight: isActive ? 700 : 400,
                                }}
                              >
                                {lesson.title}
                              </p>

                              {/* Duration badge */}
                              {lesson.duration ? (
                                <span
                                  className="shrink-0 text-[13px] tabular-nums px-2 py-0.5 rounded font-mono"
                                  style={
                                    isActive
                                      ? { background: "rgba(0,26,56,0.10)", color: "rgba(0,26,56,0.65)" }
                                      : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)" }
                                  }
                                >
                                  {formatDuration(lesson.duration)}
                                </span>
                              ) : null}
                            </Link>
                          );
                        }

                        // Quiz item
                        const quiz = entry.item;
                        const isActive = currentQuiz?.id === quiz.id;
                        const attempt = quiz.latestAttempt;
                        const passed = !!quiz.hasPassed;

                        return (
                          <Link
                            key={`quiz-${quiz.id}`}
                            to={`/student/course/${course.id}?quiz=${quiz.id}`}
                            className="flex items-center gap-3 px-4 py-3 transition-colors group"
                            style={{
                              borderBottom: "1px solid rgba(255,255,255,0.05)",
                              background: isActive ? ACTIVE_BG : undefined,
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "";
                            }}
                          >
                            {/* Status: green tick when passed, play icon otherwise */}
                            {passed ? (
                              <span
                                className="shrink-0 w-[26px] h-[26px] rounded-full flex items-center justify-center"
                                style={{ background: "#22c55e" }}
                              >
                                <Check size={14} className="text-white" strokeWidth={3} />
                              </span>
                            ) : (
                              <PlayCircle
                                size={26}
                                strokeWidth={1.75}
                                className="shrink-0"
                                style={{ color: isActive ? ACTIVE_FG : "#ffffff" }}
                              />
                            )}

                            {/* Title + attempt */}
                            <div className="flex-1 min-w-0">
                              <p
                                className="text-[15px] leading-snug"
                                style={{
                                  color: isActive ? ACTIVE_FG : "rgba(255,255,255,0.85)",
                                  fontWeight: isActive ? 700 : 400,
                                }}
                              >
                                {quiz.title}
                              </p>
                              {attempt && (
                                <span
                                  className="text-[13px] font-medium"
                                  style={{ color: attempt.isPassed ? "#4ade80" : "#f87171" }}
                                >
                                  {attempt.isPassed ? "Passed" : "Failed"} ·{" "}
                                  {attempt.maxScore > 0
                                    ? Math.round((attempt.score / attempt.maxScore) * 100)
                                    : 0}%
                                </span>
                              )}
                            </div>

                            {/* Quiz badge */}
                            <span
                              className="shrink-0 text-[13px] font-semibold px-2 py-0.5 rounded"
                              style={
                                isActive
                                  ? { background: "rgba(0,26,56,0.10)", color: "rgba(0,26,56,0.7)" }
                                  : { background: "rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.7)" }
                              }
                            >
                              Quiz
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* ── Main content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-brand-navy-deeper">

        {/* ── Top bar ──────────────────────────────────────────────────────────── */}
        <header
          className="shrink-0 flex items-center gap-3 px-4 h-16 z-20 border-b"
          style={{ background: HEADER_BG, borderColor: "rgba(0,26,56,0.10)" }}
        >
          {/* Logo → dashboard */}
          <Link to="/student" className="shrink-0" title="Back to dashboard">
            <img
              src="/std-dashboard-img/Logo.png"
              alt="Teach Me Like a Tot"
              className="h-12 w-auto object-contain"
            />
          </Link>

          {/* Learn. Grow. Do More. */}
          <img
            src="/std-dashboard-img/Learn Grow Text.png"
            alt="Learn. Grow. Do More."
            className="hidden lg:block h-9 w-auto object-contain mx-auto"
          />

          <div className="flex-1 min-w-0 lg:hidden">
            <p className="font-semibold text-[15px] truncate" style={{ color: ACTIVE_FG }}>
              {activeItem ? activeItem.item.title : course.title}
            </p>
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-3 shrink-0 ml-auto">
            {/* Progress */}
            <div className="hidden sm:block text-right">
              <p className="text-[13px]" style={{ color: "rgba(0,26,56,0.75)" }}>
                Your Progress: <strong style={{ color: ACTIVE_FG }}>{completedCount}</strong> of{" "}
                <strong style={{ color: ACTIVE_FG }}>{totalLessons}</strong> ({completionPercent}%)
              </p>
              <div className="mt-1 h-1.5 w-36 ml-auto rounded-full overflow-hidden" style={{ background: "rgba(0,26,56,0.12)" }}>
                <div className="h-full rounded-full" style={{ width: `${completionPercent}%`, background: "#2c795a" }} />
              </div>
            </div>

            {/* Mark complete / incomplete */}
            {currentLesson && !isLessonDone && (
              <button
                onClick={() => markLessonComplete(currentLesson.id)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors shrink-0"
                style={{ border: "1px solid rgba(0,26,56,0.25)", color: ACTIVE_FG }}
              >
                <CheckCircle2 size={14} />
                <span className="hidden sm:inline">MARK AS COMPLETE</span>
              </button>
            )}
            {currentLesson && isLessonDone && (
              <button
                onClick={() => markLessonIncomplete(currentLesson.id)}
                title="Clicked by mistake? Undo it."
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors shrink-0 group"
                style={{ background: "rgba(44,121,90,0.12)", color: "#1f5a42" }}
              >
                <Check size={14} className="group-hover:hidden" />
                <RotateCcw size={14} className="hidden group-hover:block" />
                <span className="hidden sm:inline group-hover:hidden">COMPLETED</span>
                <span className="hidden sm:group-hover:inline">MARK AS INCOMPLETE</span>
              </button>
            )}

            {/* Utility links. GLOSSARY and RESOURCES only appear when this
                course actually has entries — an empty drawer is worse than no
                link at all. */}
            <div className="hidden md:flex items-center gap-3 text-[13px] font-semibold tracking-wide" style={{ color: "rgba(0,26,56,0.7)" }}>
              {glossary.length > 0 && (
                <button type="button" onClick={() => setDrawer("glossary")} className="hover:underline">
                  GLOSSARY
                </button>
              )}
              {resources.length > 0 && (
                <button type="button" onClick={() => setDrawer("resources")} className="hover:underline">
                  RESOURCES
                </button>
              )}
              <Link to="/student" className="hover:underline">DASHBOARD</Link>
            </div>

            {/* Same two, icon-only, for the narrow header on phones. */}
            <div className="flex md:hidden items-center gap-1">
              {glossary.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDrawer("glossary")}
                  title="Glossary"
                  className="p-1.5 rounded transition-colors hover:bg-black/5"
                  style={{ color: "rgba(0,26,56,0.6)" }}
                >
                  <BookMarked size={16} />
                </button>
              )}
              {resources.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDrawer("resources")}
                  title="Resources"
                  className="p-1.5 rounded transition-colors hover:bg-black/5"
                  style={{ color: "rgba(0,26,56,0.6)" }}
                >
                  <Paperclip size={16} />
                </button>
              )}
            </div>

            {/* Fullscreen */}
            {!currentQuiz && (
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                className="p-1.5 rounded transition-colors shrink-0 hover:bg-black/5"
                style={{ color: "rgba(0,26,56,0.6)" }}
              >
                <Maximize2 size={16} />
              </button>
            )}

            {/* Restart storyline */}
            {isStoryline && (
              <button
                onClick={() => iframeRef.current?.contentWindow?.location.reload()}
                title="Restart"
                className="p-1.5 rounded transition-colors shrink-0 hover:bg-black/5"
                style={{ color: "rgba(0,26,56,0.6)" }}
              >
                <RotateCcw size={16} />
              </button>
            )}

            {/* Certificate */}
            {isCompleted && (
              <Link
                to={`/certificate/${course.id}`}
                className="flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-lg transition-colors font-semibold shrink-0"
                style={{ background: "rgba(198,148,69,0.15)", color: "#8a6320" }}
              >
                <Award size={13} />
                <span className="hidden sm:inline">Certificate</span>
              </Link>
            )}

            {/* Close */}
            <Link
              to="/student"
              title="Close course"
              className="p-1.5 rounded transition-colors shrink-0 hover:bg-black/5"
              style={{ color: "rgba(0,26,56,0.6)" }}
            >
              <X size={18} />
            </Link>
          </div>
        </header>

        {/* ── Glossary / Resources drawer ──────────────────────────────────── */}
        <CourseDrawer
          open={drawer}
          onClose={() => setDrawer(null)}
          resources={resources}
          glossary={glossary}
          lessonTitles={lessonTitles}
        />

        {/* ── Content area ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col">

          {/* Video / Storyline / Quiz */}
          <div className={`flex-1 relative overflow-hidden ${currentQuiz ? "bg-gray-50 overflow-y-auto" : "bg-black"}`}>

            {/* Quiz player */}
            {currentQuiz && (
              <div className="absolute inset-0 overflow-y-auto bg-gray-50">
                <QuizPlayer key={currentQuiz.id} quiz={currentQuiz} />
              </div>
            )}

            {/* Video */}
            {currentLesson?.lessonType === "VIDEO" && !currentQuiz && (
              <div className="absolute inset-0 bg-black">
                {isIframeVideo && videoSrc && (
                  <iframe
                    ref={iframeRef}
                    src={videoSrc.src}
                    title={currentLesson.title}
                    allow="autoplay; fullscreen; picture-in-picture"
                    className="absolute inset-0 w-full h-full border-0"
                    allowFullScreen
                  />
                )}
                {isHlsVideo && videoSrc && (
                  <HlsPlayer src={videoSrc.src} className="absolute inset-0 w-full h-full rounded-none" />
                )}
                {isDirectVideo && videoSrc && (
                  <video
                    ref={videoRef}
                    src={videoSrc.src}
                    controls
                    playsInline
                    controlsList="nodownload"
                    className="absolute inset-0 w-full h-full"
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    Your browser does not support HTML5 video.
                  </video>
                )}
                {!videoSrc && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <Video className="mx-auto text-gray-700 w-16 h-16 mb-3" />
                      <p className="text-gray-500 text-sm">Video URL not configured.</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Flat course video */}
            {!hasModules && !isStoryline && course.videoUrl && (
              <div className="absolute inset-0 bg-black">
                {isIframeVideo && videoSrc && (
                  <iframe ref={iframeRef} src={videoSrc.src} title={course.title} allow="autoplay; fullscreen; picture-in-picture" className="absolute inset-0 w-full h-full border-0" allowFullScreen />
                )}
                {isHlsVideo && videoSrc && (
                  <HlsPlayer src={videoSrc.src} className="absolute inset-0 w-full h-full rounded-none" />
                )}
                {isDirectVideo && videoSrc && (
                  <video ref={videoRef} src={videoSrc.src} controls playsInline controlsList="nodownload" className="absolute inset-0 w-full h-full" onContextMenu={(e) => e.preventDefault()}>
                    Your browser does not support HTML5 video.
                  </video>
                )}
              </div>
            )}

            {/* Storyline */}
            {(currentLesson?.lessonType === "STORYLINE" || (!hasModules && isStoryline)) && (
              <div className="absolute inset-0 bg-black">
                {embedUrl ? (
                  <StorylinePlayer
                    key={currentLesson?.id ?? course.id}
                    ref={iframeRef}
                    src={embedUrl}
                    title={currentLesson?.title || course.title}
                    allow="fullscreen; autoplay"
                    className="absolute inset-0 w-full h-full border-0"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
                    lessonId={currentLesson?.id ?? course.id}
                    nextLessonUrl={
                      currentLesson && nextLessonItem
                        ? itemNavUrl(nextLessonItem)
                        : null
                    }
                    onComplete={(id) => {
                      if (currentLesson && !completedSet.has(id)) {
                        markLessonComplete(id);
                      }
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <MonitorPlay className="mx-auto text-gray-700 w-16 h-16 mb-3" />
                      <p className="text-gray-500 text-sm">Storyline embed URL not configured.</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Download lesson */}
            {currentLesson?.lessonType === "DOWNLOAD" && (
              <div className="absolute inset-0 bg-gray-50 flex items-center justify-center">
                <div className="text-center max-w-md mx-auto px-6">
                  <div className="w-20 h-20 rounded-2xl bg-brand-mustard/20 border border-brand-mustard/30 flex items-center justify-center mx-auto mb-5">
                    <Download size={32} className="text-brand-mustard" />
                  </div>
                  <h2 className="text-gray-900 font-bold text-xl mb-2">{currentLesson.title}</h2>
                  <p className="text-gray-500 text-sm mb-6 leading-relaxed">Download this resource to continue learning.</p>
                  {currentLesson.resourceUrl ? (
                    <a
                      href={currentLesson.resourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => !completedSet.has(currentLesson.id) && markLessonComplete(currentLesson.id)}
                      className="inline-flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white font-semibold px-7 py-3 rounded-xl transition-colors shadow-md"
                    >
                      <Download size={16} /> Download Resource
                    </a>
                  ) : (
                    <p className="text-gray-400 text-sm">No download URL configured.</p>
                  )}
                </div>
              </div>
            )}

            {/* Text lesson */}
            {currentLesson?.lessonType === "TEXT" && (
              <div className="absolute inset-0 overflow-y-auto bg-gray-50">
                <div className="max-w-3xl mx-auto px-8 py-10">
                  <h1 className="text-2xl font-bold text-gray-900 mb-6">{currentLesson.title}</h1>
                  {currentLesson.content ? (
                    <pre className="whitespace-pre-wrap font-sans text-gray-700 leading-7 text-[15px]">
                      {currentLesson.content}
                    </pre>
                  ) : (
                    <p className="text-gray-400 text-sm">No content for this lesson.</p>
                  )}
                  {!completedSet.has(currentLesson.id) && (
                    <div className="mt-10">
                      <button
                        onClick={() => markLessonComplete(currentLesson.id)}
                        className="flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white font-semibold px-6 py-3 rounded-xl transition-colors"
                      >
                        <CheckCircle2 size={16} /> Mark as Complete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Empty state */}
            {hasModules && !activeItem && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
                <div className="text-center">
                  <div className="w-20 h-20 rounded-full bg-gray-200 flex items-center justify-center mx-auto mb-4">
                    <Play size={28} className="text-gray-400 ml-1" />
                  </div>
                  <p className="text-gray-500 font-medium">Select a lesson to begin</p>
                  <p className="text-gray-400 text-sm mt-1">Choose from the sidebar</p>
                </div>
              </div>
            )}
          </div>

          {/* ── Bottom nav bar ───────────────────────────────────────────────── */}
          {activeItem && (
            <div className="shrink-0 border-t" style={{ background: "var(--color-brand-navy-deeper)", borderColor: "rgba(255,255,255,0.08)" }}>
              {/* Description strip */}
              {((currentLesson?.content && currentLesson.lessonType !== "TEXT") ||
                (course.description && !currentLesson)) && (
                <div
                  className="px-5 py-2.5 border-b max-h-20 overflow-y-auto"
                  style={{ borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <p className="text-[13px] leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
                    {currentLesson?.content || course.description}
                  </p>
                </div>
              )}

              {/* Navigation */}
              <div className="px-5 py-3 flex items-center gap-4">
                {/* Previous lesson */}
                <div className="flex-1 flex justify-start min-w-0">
                  {prevItem ? (
                    <Link to={itemNavUrl(prevItem)} className="group min-w-0 max-w-[260px]">
                      <span
                        className="flex items-center gap-2 rounded-lg px-4 py-2 text-[15px] font-semibold transition-colors"
                        style={{ border: `1px solid ${GOLD}`, color: "#ffffff" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(190,146,76,0.18)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <ChevronLeft size={16} /> Previous Lesson
                      </span>
                      <span
                        className="hidden sm:block text-[13px] truncate mt-1 px-1"
                        style={{ color: "rgba(255,255,255,0.55)" }}
                      >
                        {prevItem.item.title}
                      </span>
                    </Link>
                  ) : null}
                </div>

                {/* Centre: position */}
                <div className="flex flex-col items-center shrink-0">
                  <span className="text-[15px] font-semibold" style={{ color: "#ffffff" }}>
                    {currentItemNumber} / {totalItems}
                  </span>
                  <span
                    className="text-[13px] uppercase tracking-wider"
                    style={{ color: "rgba(255,255,255,0.45)" }}
                  >
                    Lesson Navigation
                  </span>
                </div>

                {/* Next lesson — for Storyline lessons only once the learner
                    reaches the final slide of the scene. */}
                <div className="flex-1 flex justify-end min-w-0">
                  {nextItem && (isStoryline ? reachedLessonEnd || isLessonDone : true) ? (
                    <Link
                      to={itemNavUrl(nextItem)}
                      onClick={() => {
                        if (currentLesson && !completedSet.has(currentLesson.id)) markLessonComplete(currentLesson.id);
                      }}
                      className="group min-w-0 max-w-[260px] text-right animate-in fade-in duration-300"
                    >
                      <span
                        className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-[15px] font-semibold transition-opacity"
                        style={{ background: GOLD, color: "#001A38" }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.9")}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                      >
                        Next Lesson <ChevronLeft size={16} className="rotate-180" />
                      </span>
                      <span
                        className="hidden sm:block text-[13px] truncate mt-1 px-1"
                        style={{ color: "rgba(255,255,255,0.55)" }}
                      >
                        {nextItem.item.title}
                      </span>
                    </Link>
                  ) : nextItem ? (
                    <span
                      className="hidden sm:block text-[13px] text-right max-w-[260px]"
                      style={{ color: "rgba(255,255,255,0.35)" }}
                    >
                      Finish this lesson to continue
                    </span>
                  ) : isCompleted ? (
                    <Link
                      to={`/certificate/${course.id}`}
                      className="flex items-center gap-1.5 text-[15px] font-semibold px-4 py-2 rounded-lg transition-colors"
                      style={{ background: GOLD, color: "#001A38" }}
                    >
                      <Award size={15} /> Get Certificate
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
