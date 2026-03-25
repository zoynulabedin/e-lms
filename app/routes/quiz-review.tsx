import { data } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { CheckCircle2, ChevronDown, ChevronUp, AlertCircle, BookOpen, User } from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  // Find all QuizAttemptAnswers that need manual grading (isCorrect is null)
  const pendingRows = await prisma.$queryRaw<any[]>`
    SELECT
      qaa.id AS "attemptAnswerId",
      qaa."attemptId",
      qaa."questionId",
      qaa."answerText",
      qaa."isCorrect",
      qaa."pointsEarned",
      qaa."manualScore",
      qaa."gradedAt",
      qa."userId",
      qa."quizId",
      qa."submittedAt",
      qa."isPassed",
      qa.score,
      qa."maxScore",
      u.name AS "userName",
      u.email AS "userEmail",
      q.title AS "questionTitle",
      q.points AS "questionPoints",
      q."questionType",
      qz.title AS "quizTitle",
      c.title AS "courseTitle"
    FROM "QuizAttemptAnswer" qaa
    JOIN "QuizAttempt" qa ON qa.id = qaa."attemptId"
    JOIN "User" u ON u.id = qa."userId"
    JOIN "Question" q ON q.id = qaa."questionId"
    JOIN "Quiz" qz ON qz.id = qa."quizId"
    JOIN "Module" m ON m.id = qz."moduleId"
    JOIN "Course" c ON c.id = m."courseId"
    WHERE qaa."isCorrect" IS NULL
    ORDER BY qa."submittedAt" DESC
  `;

  // Group by attemptId
  const attemptMap = new Map<string, any>();
  for (const row of pendingRows) {
    if (!attemptMap.has(row.attemptId)) {
      attemptMap.set(row.attemptId, {
        attemptId: row.attemptId,
        quizTitle: row.quizTitle,
        courseTitle: row.courseTitle,
        userName: row.userName,
        userEmail: row.userEmail,
        submittedAt: row.submittedAt,
        score: row.score,
        maxScore: row.maxScore,
        isPassed: row.isPassed,
        questions: [],
      });
    }
    attemptMap.get(row.attemptId)!.questions.push({
      attemptAnswerId: row.attemptAnswerId,
      questionId: row.questionId,
      questionTitle: row.questionTitle,
      questionType: row.questionType,
      questionPoints: Number(row.questionPoints),
      answerText: row.answerText,
      manualScore: row.manualScore,
      gradedAt: row.gradedAt,
    });
  }

  return { pendingAttempts: Array.from(attemptMap.values()) };
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "grade_answer") {
    const attemptAnswerId = formData.get("attemptAnswerId") as string;
    const manualScore = Math.max(0, parseInt(formData.get("manualScore") as string || "0", 10));
    const maxPoints = parseInt(formData.get("maxPoints") as string || "1", 10);
    const clampedScore = Math.min(manualScore, maxPoints);
    const isCorrect = clampedScore > 0;

    await prisma.$executeRaw`
      UPDATE "QuizAttemptAnswer"
      SET "manualScore" = ${clampedScore},
          "pointsEarned" = ${clampedScore},
          "isCorrect" = ${isCorrect},
          "gradedAt" = NOW(),
          "gradedBy" = ${admin.id}
      WHERE id = ${attemptAnswerId}
    `;

    // Recalculate attempt score
    const attemptRows = await prisma.$queryRaw<any[]>`
      SELECT qaa."attemptId", SUM(qaa."pointsEarned") AS total
      FROM "QuizAttemptAnswer" qaa
      WHERE qaa."attemptId" = (SELECT "attemptId" FROM "QuizAttemptAnswer" WHERE id = ${attemptAnswerId})
      GROUP BY qaa."attemptId"
    `;
    if (attemptRows[0]) {
      const newScore = Number(attemptRows[0].total);
      const attemptId = attemptRows[0].attemptId;
      const attempt = await prisma.$queryRaw<any[]>`SELECT "maxScore", "quizId" FROM "QuizAttempt" WHERE id = ${attemptId}`;
      if (attempt[0]) {
        const quiz = await prisma.$queryRaw<any[]>`SELECT "passingGrade" FROM "Quiz" WHERE id = ${attempt[0].quizId}`;
        const passingGrade = Number(quiz[0]?.passingGrade ?? 80);
        const isPassed = attempt[0].maxScore > 0 && (newScore / Number(attempt[0].maxScore)) * 100 >= passingGrade;
        await prisma.$executeRaw`
          UPDATE "QuizAttempt" SET score = ${newScore}, "isPassed" = ${isPassed} WHERE id = ${attemptId}
        `;
      }
    }

    return data({ success: true });
  }

  return data({ ok: true });
}

function AttemptCard({ attempt }: { attempt: any }) {
  const [open, setOpen] = useState(true);
  const fetcher = useFetcher<{ success?: boolean }>();

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm truncate">{attempt.quizTitle}</p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{attempt.courseTitle}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <User size={11} /> {attempt.userName}
            </div>
            <p className="text-[11px] text-gray-400">{attempt.userEmail}</p>
          </div>
          <div className={`px-2.5 py-1 rounded-full text-xs font-semibold ${attempt.isPassed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
            {attempt.score}/{attempt.maxScore}
          </div>
          <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 font-medium">
            {attempt.questions.length} pending
          </span>
          {open ? <ChevronUp size={15} className="text-gray-400" /> : <ChevronDown size={15} className="text-gray-400" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {attempt.questions.map((q: any) => (
            <div key={q.attemptAnswerId} className="px-5 py-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                  {q.questionType === "ESSAY" ? "E" : "S"}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-800">{q.questionTitle}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{q.questionType.replace("_", " ")} · max {q.questionPoints} pts</p>
                </div>
              </div>

              {q.answerText ? (
                <div className="ml-9 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700 mb-3 whitespace-pre-wrap">
                  {q.answerText}
                </div>
              ) : (
                <p className="ml-9 text-xs text-gray-400 italic mb-3">No answer provided</p>
              )}

              <fetcher.Form method="post" className="ml-9 flex items-center gap-3">
                <input type="hidden" name="intent" value="grade_answer" />
                <input type="hidden" name="attemptAnswerId" value={q.attemptAnswerId} />
                <input type="hidden" name="maxPoints" value={q.questionPoints} />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600 font-medium">Score:</label>
                  <input
                    type="number"
                    name="manualScore"
                    min={0}
                    max={q.questionPoints}
                    defaultValue={q.manualScore ?? 0}
                    className="w-16 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-xs text-gray-400">/ {q.questionPoints}</span>
                </div>
                <button
                  type="submit"
                  disabled={fetcher.state !== "idle"}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition-colors"
                >
                  <CheckCircle2 size={12} />
                  {fetcher.state !== "idle" ? "Saving…" : "Save Grade"}
                </button>
                {fetcher.data?.success && (
                  <span className="text-xs text-green-600 font-medium">✓ Saved</span>
                )}
              </fetcher.Form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QuizReview() {
  const { pendingAttempts } = useLoaderData<typeof loader>();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Quiz Review</h1>
          <p className="text-gray-500 text-sm mt-1">Grade open-ended and short-answer responses</p>
        </div>
        {pendingAttempts.length > 0 && (
          <span className="bg-amber-100 text-amber-700 text-sm font-semibold px-3 py-1 rounded-full">
            {pendingAttempts.reduce((s: number, a: any) => s + a.questions.length, 0)} pending
          </span>
        )}
      </div>

      {pendingAttempts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 py-20 flex flex-col items-center text-center">
          <CheckCircle2 size={40} className="text-green-400 mb-4" />
          <p className="text-gray-700 font-semibold">All caught up!</p>
          <p className="text-gray-400 text-sm mt-1">No open-ended answers pending review.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingAttempts.map((attempt: any) => (
            <AttemptCard key={attempt.attemptId} attempt={attempt} />
          ))}
        </div>
      )}
    </div>
  );
}
