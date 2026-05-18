import { data } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { randomUUID } from "crypto";
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
  Award,
  RotateCcw,
  Maximize2,
  Lock,
  Bookmark,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  if (trimmed.includes(".m3u8"))
    return { type: "hls", src: trimmed };
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
    prisma.course.findUnique({
      where: { id: courseId },
      include: {
        modules: {
          orderBy: { order: "asc" },
          include: { lessons: { orderBy: { order: "asc" } } },
        },
      },
    }),
  ]);

  if (!course) throw data({ message: "Course not found." }, { status: 404 });

  const hasAccess =
    license ||
    enrollment ||
    (course.courseType === "FREE" && course.status === "PUBLISHED");

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
      where: { userId: user.id },
      select: { lessonId: true, isCompleted: true },
    }),
  ]);

  // Quizzes with questions and answers (no isCorrect exposed)
  const quizRows = await prisma.$queryRaw<any[]>`
    SELECT * FROM "Quiz"
    WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
    ORDER BY "order"
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
    SELECT a.id, a."questionId", a.text, a."imageUrl", a."videoUrl", a."matchText",
      CASE WHEN q."questionType" = 'TRUE_FALSE' THEN a."isCorrect" ELSE NULL END AS "isCorrect"
    FROM "Answer" a
    JOIN "Question" q ON a."questionId" = q.id
    WHERE a."questionId" IN (
      SELECT id FROM "Question"
      WHERE "quizId" IN (
        SELECT id FROM "Quiz"
        WHERE "moduleId" IN (SELECT id FROM "Module" WHERE "courseId" = ${courseId})
      )
    )
    ORDER BY a.id
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

  const questionsMap: Record<string, any[]> = {};
  for (const q of questionRows) {
    (q as any).answers = answersMap[q.id] || [];
    if (!questionsMap[q.quizId]) questionsMap[q.quizId] = [];
    questionsMap[q.quizId].push(q);
  }

  const attemptsMap: Record<string, any> = {};
  for (const a of quizAttemptRows) {
    if (!attemptsMap[a.quizId]) attemptsMap[a.quizId] = a;
  }

  const quizzesWithData = quizRows.map((q) => ({
    ...q,
    questions: questionsMap[q.id] || [],
    latestAttempt: attemptsMap[q.id] || null,
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
    course,
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
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_progress") {
    const percent = Math.min(100, Math.max(0, parseInt(String(formData.get("percent") || "0"), 10)));
    const completed = String(formData.get("completed")) === "true";
    await prisma.progress.upsert({
      where: { userId_courseId: { userId: user.id, courseId } },
      update: { completionPercent: percent, isCompleted: completed, completedAt: completed ? new Date() : null, lastAccessedAt: new Date() },
      create: { userId: user.id, courseId, completionPercent: percent, isCompleted: completed, completedAt: completed ? new Date() : null },
    });
  }

  if (intent === "complete_lesson") {
    const lessonId = formData.get("lessonId") as string;
    await prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId: user.id, lessonId } },
      update: { isCompleted: true, completedAt: new Date() },
      create: { userId: user.id, lessonId, isCompleted: true, completedAt: new Date() },
    });

    const courseWithModules = await prisma.course.findUnique({
      where: { id: courseId },
      include: { modules: { include: { lessons: { select: { id: true } } } } },
    });
    const allLessonIds = courseWithModules?.modules.flatMap((m) => m.lessons.map((l) => l.id)) ?? [];

    if (allLessonIds.length > 0) {
      const completedCount = await prisma.lessonProgress.count({
        where: { userId: user.id, lessonId: { in: allLessonIds }, isCompleted: true },
      });
      const percent = Math.round((completedCount / allLessonIds.length) * 100);
      const isCompleted = percent >= 100;
      await prisma.progress.upsert({
        where: { userId_courseId: { userId: user.id, courseId } },
        update: { completionPercent: percent, isCompleted, completedAt: isCompleted ? new Date() : null, lastAccessedAt: new Date() },
        create: { userId: user.id, courseId, completionPercent: percent, isCompleted, completedAt: isCompleted ? new Date() : null },
      });
    }
  }

  if (intent === "submit_quiz") {
    const quizId = formData.get("quizId") as string;
    const quizRows = await prisma.$queryRaw<any[]>`SELECT * FROM "Quiz" WHERE id = ${quizId}`;
    const quiz = quizRows[0];
    if (!quiz) return data({ error: "Quiz not found" }, { status: 404 });

    const questions = await prisma.$queryRaw<any[]>`
      SELECT * FROM "Question" WHERE "quizId" = ${quizId} ORDER BY "order"
    `;

    let score = 0;
    let maxScore = 0;
    const questionResults: any[] = [];

    for (const q of questions) {
      const answers = await prisma.$queryRaw<any[]>`SELECT * FROM "Answer" WHERE "questionId" = ${q.id}`;
      const points = Number(q.points);
      maxScore += points;
      const type = q.questionType;

      let pointsEarned = 0;
      let isCorrect: boolean | null = null;
      let submittedAnswerId: string | null = null;
      let submittedText: string | null = null;

      if (type === "MULTIPLE_CHOICE" || type === "TRUE_FALSE" || type === "IMAGE_ANSWERING" || type === "VIDEO_ANSWERING") {
        submittedAnswerId = (formData.get(`answer_${q.id}`) as string) || null;
        isCorrect = !!submittedAnswerId && answers.some((a: any) => a.id === submittedAnswerId && a.isCorrect);
        if (isCorrect) { pointsEarned = points; score += points; }
      } else if (type === "FILL_BLANK") {
        submittedText = ((formData.get(`answer_${q.id}`) as string) || "").trim().toLowerCase();
        const correctTexts = answers.filter((a: any) => a.isCorrect).map((a: any) => a.text.toLowerCase());
        isCorrect = correctTexts.some((c: string) => c === submittedText);
        if (isCorrect) { pointsEarned = points; score += points; }
      } else if (type === "ESSAY" || type === "SHORT_ANSWER") {
        submittedText = (formData.get(`answer_${q.id}`) as string) || null;
        isCorrect = null; // needs manual grading
        pointsEarned = 0;
      } else {
        // MATCHING, ORDERING — full credit
        pointsEarned = points;
        score += points;
        isCorrect = true;
      }

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

    return data({ ok: true, score, maxScore, isPassed, passingGrade, feedbackMode: quiz.feedbackMode, attemptId, questionResults });
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

function QuestionBlock({
  question,
  index,
  value,
  onChange,
}: {
  question: any;
  index: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const type = question.questionType;
  const answers: any[] = question.answers || [];
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
        <span className="shrink-0 text-[12px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
          {Number(question.points)} pt{Number(question.points) !== 1 ? "s" : ""}
        </span>
      </div>

      {type === "TRUE_FALSE" && (
        <div className="space-y-2 pl-10">
          {answers.filter((a: any, i: number, arr: any[]) =>
            arr.findIndex((x: any) => x.text === a.text) === i
          ).slice(0, 2).map((a: any) => {
            const isSelected = value === a.id;
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
          {answers.map((a: any) => {
            const isSelected = value === a.id;
            return (
              <div key={a.id}>
                <label
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
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
            const isSelected = value === a.id;
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
              <input
                type="text"
                name={`answer_${question.id}_${a.id}`}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-blue-500"
                placeholder="Match..."
              />
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
    ok?: boolean; score?: number; maxScore?: number; isPassed?: boolean; passingGrade?: number;
    feedbackMode?: string; attemptId?: string; questionResults?: any[];
  }>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
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
    if (timeLeft === 0 && !submitted) formRef.current?.requestSubmit();
  }, [timeLeft, submitted]);

  if (submitted && result) {
    const pct = result.maxScore! > 0 ? Math.round((result.score! / result.maxScore!) * 100) : 0;
    const isPassed = !!result.isPassed;
    const feedbackMode = result.feedbackMode ?? "DEFAULT";
    const hasReview = (feedbackMode === "REVEAL" || feedbackMode === "RETRY") && Array.isArray(result.questionResults) && result.questionResults.length > 0;

    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        {isPassed && <Confetti />}

        {/* Score Arc */}
        <div className="flex flex-col items-center mb-8">
          <ScoreArc pct={pct} isPassed={isPassed} />

          <div className={`mt-5 inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold border ${
            isPassed ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-600 border-red-200"
          }`}>
            {isPassed ? <><Trophy size={14} /> Quiz Passed!</> : <><AlertCircle size={14} /> Quiz Failed</>}
          </div>

          <p className="text-gray-500 text-sm mt-3">
            <span className="font-semibold text-gray-800">{result.score} / {result.maxScore}</span> points &nbsp;·&nbsp; Passing grade: {result.passingGrade}%
          </p>

          {!isPassed && (
            <p className="text-gray-400 text-xs mt-1">You need {result.passingGrade}% or higher to pass.</p>
          )}

          {result.questionResults?.some((qr: any) => qr.isCorrect === null) && (
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

        {/* Retake */}
        <div className="flex justify-center">
          <button
            onClick={onRetake}
            className="flex items-center gap-2 border border-gray-300 hover:border-gray-400 text-gray-700 hover:text-gray-900 bg-white px-6 py-2.5 rounded-xl transition-colors text-sm font-medium shadow-sm"
          >
            <RefreshCw size={14} /> Retake Quiz
          </button>
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
          {Number(quiz.attemptsAllowed) > 0 && <span>Max attempts: {quiz.attemptsAllowed}</span>}
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
      ) : (
        <quizFetcher.Form method="post" ref={formRef}>
          <input type="hidden" name="intent" value="submit_quiz" />
          <input type="hidden" name="quizId" value={quiz.id} />
          {questions.map((q: any, idx: number) => (
            <QuestionBlock
              key={q.id}
              question={q}
              index={idx}
              value={answers[q.id] || ""}
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

// ── CourseViewer ──────────────────────────────────────────────────────────────

export default function CourseViewer() {
  const {
    course,
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(
    new Set(course.modules.map((m: any) => m.id)),
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

  const completedCount = completedLessonIds.length;

  // Storyline postMessage
  useEffect(() => {
    if (!isStoryline) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (msg?.type === "progress" && typeof msg.percent === "number") {
          const fd = new FormData();
          fd.append("intent", "update_progress");
          fd.append("percent", String(msg.percent));
          fd.append("completed", msg.percent >= 100 ? "true" : "false");
          fetcher.submit(fd, { method: "post" });
        }
      } catch { /* non-JSON */ }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fetcher, isStoryline]);

  // Video timeupdate
  useEffect(() => {
    if (isStoryline) return;
    const video = videoRef.current;
    if (!video) return;
    let lastReported = 0;
    const onTimeUpdate = () => {
      if (!video.duration) return;
      const pct = Math.round((video.currentTime / video.duration) * 100);
      if (Math.abs(pct - lastReported) >= 5) {
        lastReported = pct;
        const fd = new FormData();
        fd.append("intent", "update_progress");
        fd.append("percent", String(pct));
        fd.append("completed", pct >= 95 ? "true" : "false");
        fetcher.submit(fd, { method: "post" });
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [fetcher, isStoryline]);

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

  const markLessonComplete = (lessonId: string) => {
    const fd = new FormData();
    fd.append("intent", "complete_lesson");
    fd.append("lessonId", lessonId);
    fetcher.submit(fd, { method: "post" });
  };

  const toggleModule = (id: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const itemNavUrl = (item: { type: string; item: any } | null) => {
    if (!item) return "#";
    return item.type === "lesson"
      ? `/student/course/${course.id}?lesson=${item.item.id}`
      : `/student/course/${course.id}?quiz=${item.item.id}`;
  };

  const isLessonDone = currentLesson ? completedSet.has(currentLesson.id) : false;

  return (
    <div className="h-screen flex overflow-hidden bg-brand-navy-dark">

      {/* ── Sidebar ────────────────────────────────────────────────────────────── */}
      {hasModules && (
        <aside
          className="w-[360px] shrink-0 flex flex-col overflow-hidden"
          style={{ background: "var(--color-brand-navy-dark)" }}
        >
          {/* Module list */}
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#3b82f6 transparent" }}
          >
            {course.modules.map((module: any, moduleIdx: number) => {
              const expanded = expandedModules.has(module.id);
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
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors"
                    style={{ background: "var(--color-brand-navy)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#2c4a78")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--color-brand-navy)")}
                  >
                    <Lock size={17} className="text-blue-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-white text-[15px] leading-snug">
                        {module.title}
                      </p>
                      <p className="text-slate-400 text-[13px] mt-0.5">
                        {totalInModule} episode{totalInModule !== 1 ? "s" : ""}
                      </p>
                    </div>
                    {expanded
                      ? <ChevronUp size={15} className="text-slate-400 shrink-0" />
                      : <ChevronDown size={15} className="text-slate-400 shrink-0" />}
                  </button>

                  {/* Item list */}
                  {expanded && (
                    <div>
                      {moduleItems.map((entry, entryIdx) => {
                        if (entry.type === "lesson") {
                          const lesson = entry.item;
                          const isDone = completedSet.has(lesson.id);
                          const isActive = currentLesson?.id === lesson.id;
                          const itemNum = entryIdx + 1;

                          return (
                            <Link
                              key={`lesson-${lesson.id}`}
                              to={`/student/course/${course.id}?lesson=${lesson.id}`}
                              className="flex items-center gap-3 px-4 py-3.5 transition-colors group"
                              style={{
                                borderBottom: "1px solid rgba(255,255,255,0.04)",
                                background: isActive ? "rgba(59,130,246,0.12)" : undefined,
                              }}
                              onMouseEnter={(e) => {
                                if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isActive) e.currentTarget.style.background = "";
                              }}
                            >
                              {/* Completion checkbox */}
                              <div
                                className="shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors"
                                style={{
                                  borderColor: isDone ? "#22c55e" : "rgba(255,255,255,0.25)",
                                  background: isDone ? "#22c55e" : "transparent",
                                }}
                              >
                                {isDone && <Check size={10} className="text-white" strokeWidth={3} />}
                              </div>

                              {/* Bookmark */}
                              <Bookmark
                                size={13}
                                className="shrink-0"
                                style={{ color: isActive ? "#60a5fa" : "rgba(255,255,255,0.3)" }}
                              />

                              {/* Number badge */}
                              <div
                                className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-semibold"
                                style={{ background: "#1a2a40", color: "#94a3b8" }}
                              >
                                {itemNum}
                              </div>

                              {/* Title */}
                              <p
                                className="flex-1 text-[15px] leading-snug min-w-0"
                                style={{ color: isActive ? "#ffffff" : "rgba(255,255,255,0.75)" }}
                              >
                                {lesson.title}
                              </p>

                              {/* Duration badge */}
                              {lesson.duration ? (
                                <span
                                  className="shrink-0 text-[13px] tabular-nums px-2 py-0.5 rounded font-mono"
                                  style={{ background: "#1a2a40", color: "#94a3b8" }}
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
                        const itemNum = entryIdx + 1;

                        return (
                          <Link
                            key={`quiz-${quiz.id}`}
                            to={`/student/course/${course.id}?quiz=${quiz.id}`}
                            className="flex items-center gap-3 px-4 py-3.5 transition-colors group"
                            style={{
                              borderBottom: "1px solid rgba(255,255,255,0.04)",
                              background: isActive ? "rgba(168,85,247,0.12)" : undefined,
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "";
                            }}
                          >
                            {/* Completion checkbox */}
                            <div
                              className="shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center"
                              style={{
                                borderColor: attempt?.isPassed ? "#22c55e" : "rgba(255,255,255,0.25)",
                                background: attempt?.isPassed ? "#22c55e" : "transparent",
                              }}
                            >
                              {attempt?.isPassed && <Check size={10} className="text-white" strokeWidth={3} />}
                            </div>

                            {/* Bookmark */}
                            <Bookmark
                              size={13}
                              className="shrink-0"
                              style={{ color: isActive ? "#c084fc" : "rgba(255,255,255,0.3)" }}
                            />

                            {/* Number badge */}
                            <div
                              className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-semibold"
                              style={{ background: "#1a2a40", color: "#94a3b8" }}
                            >
                              {itemNum}
                            </div>

                            {/* Title + attempt */}
                            <div className="flex-1 min-w-0">
                              <p
                                className="text-[15px] leading-snug"
                                style={{ color: isActive ? "#e9d5ff" : "rgba(255,255,255,0.75)" }}
                              >
                                {quiz.title}
                              </p>
                              {attempt && (
                                <span
                                  className="text-[12px] font-medium"
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
                              className="shrink-0 text-[12px] font-semibold px-2 py-0.5 rounded"
                              style={{ background: "rgba(168,85,247,0.2)", color: "#c084fc" }}
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
      <div className="flex-1 flex flex-col overflow-hidden bg-brand-navy-dark">

        {/* ── Blue top bar ─────────────────────────────────────────────────────── */}
        <header className="shrink-0 bg-brand-navy flex items-center px-4 h-14 gap-3 z-20">
          {/* Back */}
          <Link
            to="/student"
            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/15 text-white transition-colors shrink-0"
          >
            <ChevronLeft size={20} />
          </Link>

          {/* Course/lesson title */}
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm truncate">
              {activeItem ? activeItem.item.title : course.title}
            </p>
            {activeItem && (
              <p className="text-blue-200 text-xs truncate">{course.title}</p>
            )}
          </div>

          {/* Progress */}
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <span className="text-blue-100 text-xs">
              Your Progress:{" "}
              <strong className="text-white">{completedCount}</strong>{" "}
              of{" "}
              <strong className="text-white">{totalLessons}</strong>{" "}
              <span className="text-blue-200">({completionPercent}%)</span>
            </span>
          </div>

          {/* Mark complete button */}
          {currentLesson && !isLessonDone && (
            <button
              onClick={() => markLessonComplete(currentLesson.id)}
              className="flex items-center gap-1.5 text-white border border-white/40 hover:bg-white/15 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors shrink-0"
            >
              <CheckCircle2 size={13} />
              <span className="hidden sm:inline">MARK AS COMPLETE</span>
            </button>
          )}
          {currentLesson && isLessonDone && (
            <div className="flex items-center gap-1.5 text-white bg-white/15 rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0">
              <Check size={13} />
              <span className="hidden sm:inline">COMPLETED</span>
            </div>
          )}

          {/* Fullscreen */}
          {!currentQuiz && (
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              className="text-white/70 hover:text-white p-1.5 rounded hover:bg-white/15 transition-colors shrink-0"
            >
              <Maximize2 size={14} />
            </button>
          )}

          {/* Restart storyline */}
          {isStoryline && (
            <button
              onClick={() => iframeRef.current?.contentWindow?.location.reload()}
              title="Restart"
              className="text-white/70 hover:text-white p-1.5 rounded hover:bg-white/15 transition-colors shrink-0"
            >
              <RotateCcw size={14} />
            </button>
          )}

          {/* Certificate */}
          {isCompleted && (
            <Link
              to={`/certificate/${course.id}`}
              className="flex items-center gap-1.5 text-xs text-amber-300 bg-amber-300/15 hover:bg-amber-300/25 border border-amber-300/40 px-3 py-1.5 rounded-lg transition-colors font-semibold shrink-0"
            >
              <Award size={12} />
              <span className="hidden sm:inline">Certificate</span>
            </Link>
          )}

          {/* Close */}
          <Link
            to="/student"
            className="text-white/60 hover:text-white p-1.5 rounded hover:bg-white/15 transition-colors shrink-0"
          >
            <X size={18} />
          </Link>
        </header>

        {/* ── Content area ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col">

          {/* Video / Storyline / Quiz */}
          <div className={`flex-1 relative overflow-hidden ${currentQuiz ? "bg-gray-50 overflow-y-auto" : "bg-black"}`}>

            {/* Quiz player */}
            {currentQuiz && (
              <div className="absolute inset-0 overflow-y-auto bg-gray-50">
                <QuizPlayer quiz={currentQuiz} />
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
            <div className="shrink-0 border-t" style={{ background: "var(--color-brand-navy-dark)", borderColor: "rgba(255,255,255,0.06)" }}>
              {/* Description strip */}
              {((currentLesson?.content && currentLesson.lessonType !== "TEXT") ||
                (course.description && !currentLesson)) && (
                <div
                  className="px-5 py-2.5 border-b max-h-20 overflow-y-auto"
                  style={{ borderColor: "rgba(255,255,255,0.06)" }}
                >
                  <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
                    {currentLesson?.content || course.description}
                  </p>
                </div>
              )}

              {/* Navigation */}
              <div className="px-5 py-3 flex items-center gap-4">
                {/* Prev */}
                <div className="flex-1 flex justify-start">
                  {prevItem ? (
                    <Link to={itemNavUrl(prevItem)} className="flex items-center gap-2 group max-w-xs">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0"
                        style={{ background: "rgba(255,255,255,0.08)" }}
                      >
                        <ChevronLeft size={16} style={{ color: "rgba(255,255,255,0.5)" }} />
                      </div>
                      <div className="hidden sm:block min-w-0">
                        <p className="text-[12px] uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.3)" }}>Previous</p>
                        <p className="text-xs truncate max-w-[160px]" style={{ color: "rgba(255,255,255,0.6)" }}>
                          {prevItem.item.title}
                        </p>
                      </div>
                    </Link>
                  ) : (
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center opacity-20" style={{ background: "rgba(255,255,255,0.08)" }}>
                      <ChevronLeft size={16} style={{ color: "rgba(255,255,255,0.5)" }} />
                    </div>
                  )}
                </div>

                {/* Center */}
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>
                    {currentItemNumber} / {totalItems}
                  </span>
                  {currentQuiz && (
                    <span
                      className="flex items-center gap-1 text-[13px] font-semibold px-2.5 py-1 rounded-lg"
                      style={{ background: "rgba(168,85,247,0.2)", color: "#c084fc" }}
                    >
                      <HelpCircle size={11} /> Quiz
                    </span>
                  )}
                </div>

                {/* Next */}
                <div className="flex-1 flex justify-end">
                  {nextItem ? (
                    <Link
                      to={itemNavUrl(nextItem)}
                      onClick={() => {
                        if (currentLesson && !completedSet.has(currentLesson.id)) markLessonComplete(currentLesson.id);
                      }}
                      className="flex items-center gap-2 group max-w-xs"
                    >
                      <div className="hidden sm:block min-w-0 text-right">
                        <p className="text-[12px] uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.3)" }}>Next</p>
                        <p className="text-xs truncate max-w-[160px]" style={{ color: "rgba(255,255,255,0.6)" }}>
                          {nextItem.item.title}
                        </p>
                      </div>
                      <div className="w-8 h-8 rounded-lg bg-brand-navy hover:bg-brand-navy-dark flex items-center justify-center transition-colors shrink-0 shadow-lg">
                        <ChevronLeft size={16} className="text-white rotate-180" />
                      </div>
                    </Link>
                  ) : (
                    <div className="flex items-center gap-2">
                      {isCompleted && (
                        <Link
                          to={`/certificate/${course.id}`}
                          className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                          style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}
                        >
                          <Award size={13} /> Get Certificate
                        </Link>
                      )}
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center opacity-20" style={{ background: "rgba(255,255,255,0.08)" }}>
                        <ChevronLeft size={16} className="text-white rotate-180" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
