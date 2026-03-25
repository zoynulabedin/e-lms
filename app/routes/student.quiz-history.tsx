import { useLoaderData, Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { Trophy, AlertCircle, ChevronDown, ChevronUp, CheckCircle2, X, HelpCircle, BookOpen, Clock } from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const attempts = await prisma.$queryRaw<any[]>`
    SELECT
      qa.id AS "attemptId",
      qa.score,
      qa."maxScore",
      qa."isPassed",
      qa."submittedAt",
      qz.title AS "quizTitle",
      qz."passingGrade",
      qz."feedbackMode",
      c.title AS "courseTitle",
      c.id AS "courseId"
    FROM "QuizAttempt" qa
    JOIN "Quiz" qz ON qz.id = qa."quizId"
    JOIN "Module" m ON m.id = qz."moduleId"
    JOIN "Course" c ON c.id = m."courseId"
    WHERE qa."userId" = ${user.id}
    ORDER BY qa."submittedAt" DESC
    LIMIT 100
  `;

  const answerRows = attempts.length > 0 ? await prisma.$queryRaw<any[]>`
    SELECT
      qaa.id,
      qaa."attemptId",
      qaa."isCorrect",
      qaa."pointsEarned",
      qaa."answerText",
      qaa."manualScore",
      q.title AS "questionTitle",
      q."questionType",
      q.points
    FROM "QuizAttemptAnswer" qaa
    JOIN "Question" q ON q.id = qaa."questionId"
    WHERE qaa."attemptId" IN (
      SELECT id FROM "QuizAttempt" WHERE "userId" = ${user.id}
    )
    ORDER BY qaa."attemptId", q."order"
  ` : [];

  const answersMap: Record<string, any[]> = {};
  for (const a of answerRows) {
    if (!answersMap[a.attemptId]) answersMap[a.attemptId] = [];
    answersMap[a.attemptId].push(a);
  }

  return {
    attempts: attempts.map((a: any) => ({
      ...a,
      answers: answersMap[a.attemptId] || [],
    })),
  };
}

function AttemptRow({ attempt }: { attempt: any }) {
  const [open, setOpen] = useState(false);
  const pct = attempt.maxScore > 0 ? Math.round((attempt.score / attempt.maxScore) * 100) : 0;
  const date = new Date(attempt.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const hasAnswers = attempt.answers.length > 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${attempt.isPassed ? "bg-green-100" : "bg-red-100"}`}>
          {attempt.isPassed
            ? <Trophy size={18} className="text-green-600" />
            : <AlertCircle size={18} className="text-red-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm truncate">{attempt.quizTitle}</p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{attempt.courseTitle}</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <p className={`text-sm font-bold ${attempt.isPassed ? "text-green-600" : "text-red-500"}`}>{pct}%</p>
            <p className="text-[11px] text-gray-400">{attempt.score}/{attempt.maxScore} pts</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">{date}</p>
            <p className={`text-[11px] font-medium mt-0.5 ${attempt.isPassed ? "text-green-600" : "text-red-500"}`}>
              {attempt.isPassed ? "Passed" : "Failed"}
            </p>
          </div>
          {hasAnswers && (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            >
              {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
            </button>
          )}
        </div>
      </div>

      {open && hasAnswers && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Your Answers</p>
          {attempt.answers.map((a: any) => {
            const isPending = a.isCorrect === null;
            const isCorrect = a.isCorrect === true;
            return (
              <div key={a.id} className={`flex items-start gap-3 p-3 rounded-xl border text-sm ${isPending ? "border-gray-200 bg-gray-50" : isCorrect ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                <div className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold mt-0.5 ${isPending ? "bg-gray-400" : isCorrect ? "bg-green-500" : "bg-red-500"}`}>
                  {isPending ? "?" : isCorrect ? "✓" : "✗"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 text-sm">{a.questionTitle}</p>
                  {a.answerText && <p className="text-xs text-gray-500 mt-1 truncate">"{a.answerText}"</p>}
                  {isPending && <p className="text-xs text-amber-500 mt-0.5">Pending review</p>}
                </div>
                <span className="text-xs text-gray-500 shrink-0">{a.pointsEarned}/{Number(a.points)} pt</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function StudentQuizHistory() {
  const { attempts } = useLoaderData<typeof loader>();

  const passed = attempts.filter((a: any) => a.isPassed).length;
  const total = attempts.length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="mb-8">
          <Link to="/student/dashboard" className="text-sm text-blue-600 hover:underline flex items-center gap-1 mb-4">
            ← Back to Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">Quiz History</h1>
          <p className="text-gray-500 text-sm mt-1">All your quiz attempts</p>
        </div>

        {/* Stats */}
        {total > 0 && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-white rounded-2xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-black text-gray-900">{total}</p>
              <p className="text-xs text-gray-500 mt-1">Total Attempts</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-black text-green-600">{passed}</p>
              <p className="text-xs text-gray-500 mt-1">Passed</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-200 p-4 text-center">
              <p className="text-2xl font-black text-gray-900">
                {total > 0 ? Math.round((passed / total) * 100) : 0}%
              </p>
              <p className="text-xs text-gray-500 mt-1">Pass Rate</p>
            </div>
          </div>
        )}

        {attempts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 py-20 flex flex-col items-center text-center">
            <BookOpen size={40} className="text-gray-300 mb-4" />
            <p className="text-gray-700 font-semibold">No quiz attempts yet</p>
            <p className="text-gray-400 text-sm mt-1">Take a quiz in any course to see your history here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {attempts.map((attempt: any) => (
              <AttemptRow key={attempt.attemptId} attempt={attempt} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
