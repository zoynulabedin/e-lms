import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import {
  Trophy,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  BookOpen,
} from "lucide-react";
import { useState } from "react";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";

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

  const answerRows =
    attempts.length > 0
      ? await prisma.$queryRaw<any[]>`
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
  `
      : [];

  const answersMap: Record<string, any[]> = {};
  for (const a of answerRows) {
    if (!answersMap[a.attemptId]) answersMap[a.attemptId] = [];
    answersMap[a.attemptId].push(a);
  }

  const completedCount = await prisma.progress.count({
    where: { userId: user.id, isCompleted: true },
  });

  return {
    user,
    hasCertificates: completedCount > 0,
    attempts: attempts.map((a: any) => ({
      ...a,
      answers: answersMap[a.attemptId] || [],
    })),
  };
}

export default function StudentQuizHistory() {
  const { user, hasCertificates, attempts } = useLoaderData<typeof loader>();

  const passed = attempts.filter((a: any) => a.isPassed).length;
  const total = attempts.length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar
          user={user}
          active="quiz-history"
          certificatesEnabled={hasCertificates}
        />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar />
          <StudentTopbar user={user} />

          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
            {/* Hero */}
            <div className="mb-8">
              <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
                <Trophy size={14} />
                Quiz History
              </div>
              <h1 className="font-display text-4xl sm:text-5xl text-brand-navy">
                Your Attempts
              </h1>
              <p className="text-brand-navy/60 mt-2 max-w-2xl">
                Every quiz you've taken, with scores and answer breakdowns.
              </p>
            </div>

            {/* Stats */}
            {total > 0 && (
              <div className="grid grid-cols-3 gap-3 sm:gap-5 mb-10">
                <StatCard
                  value={total}
                  label="Total"
                  sublabel="Attempts"
                  tone="navy"
                />
                <StatCard
                  value={passed}
                  label="Passed"
                  sublabel="Quizzes"
                  tone="green"
                />
                <StatCard
                  value={`${passRate}%`}
                  label="Pass"
                  sublabel="Rate"
                  tone="mustard"
                />
              </div>
            )}

            {/* Attempts list */}
            {attempts.length === 0 ? (
              <div className="text-center py-20 border-2 border-dashed border-brand-beige-dark rounded-2xl bg-white">
                <div className="w-14 h-14 rounded-full bg-brand-mustard/15 flex items-center justify-center mx-auto mb-4">
                  <BookOpen className="text-brand-mustard w-7 h-7" />
                </div>
                <p className="font-display text-2xl text-brand-navy mb-1">
                  No quiz attempts yet
                </p>
                <p className="text-brand-navy/60 text-sm max-w-md mx-auto">
                  Take a quiz in any course and your attempt history will appear
                  here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {attempts.map((attempt: any) => (
                  <AttemptRow key={attempt.attemptId} attempt={attempt} />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  sublabel,
  tone,
}: {
  value: number | string;
  label: string;
  sublabel: string;
  tone: "navy" | "green" | "mustard";
}) {
  const tones: Record<
    typeof tone,
    { iconBg: string; iconColor: string; valueColor: string }
  > = {
    navy: {
      iconBg: "bg-brand-navy/10",
      iconColor: "text-brand-navy",
      valueColor: "text-brand-navy",
    },
    green: {
      iconBg: "bg-brand-green/10",
      iconColor: "text-brand-green-dark",
      valueColor: "text-brand-green-dark",
    },
    mustard: {
      iconBg: "bg-brand-mustard/15",
      iconColor: "text-brand-mustard",
      valueColor: "text-brand-mustard",
    },
  };
  const t = tones[tone];
  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark p-5 sm:p-6">
      <div
        className={`w-10 h-10 rounded-lg ${t.iconBg} flex items-center justify-center mb-3`}
      >
        <Trophy className={`${t.iconColor} w-5 h-5`} />
      </div>
      <p
        className={`text-3xl sm:text-4xl font-bold ${t.valueColor} leading-none`}
      >
        {value}
      </p>
      <p className="text-sm font-semibold text-brand-navy mt-2 leading-tight">
        {label}
      </p>
      <p className="text-xs text-brand-navy/60 leading-tight">{sublabel}</p>
    </div>
  );
}

// ── Attempt row ───────────────────────────────────────────────────────────────

function AttemptRow({ attempt }: { attempt: any }) {
  const [open, setOpen] = useState(false);
  const pct =
    attempt.maxScore > 0
      ? Math.round((attempt.score / attempt.maxScore) * 100)
      : 0;
  const date = new Date(attempt.submittedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const hasAnswers = attempt.answers.length > 0;
  const isPassed = attempt.isPassed;

  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4">
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
            isPassed ? "bg-brand-green/15" : "bg-red-100"
          }`}
        >
          {isPassed ? (
            <Trophy size={18} className="text-brand-green-dark" />
          ) : (
            <AlertCircle size={18} className="text-red-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-brand-navy text-sm truncate">
            {attempt.quizTitle}
          </p>
          <p className="text-xs text-brand-navy/55 mt-0.5 truncate">
            {attempt.courseTitle}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <p
              className={`text-sm font-bold ${
                isPassed ? "text-brand-green-dark" : "text-red-500"
              }`}
            >
              {pct}%
            </p>
            <p className="text-[11px] text-brand-navy/45">
              {attempt.score}/{attempt.maxScore} pts
            </p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-brand-navy/55">{date}</p>
            <p
              className={`text-[11px] font-semibold mt-0.5 uppercase tracking-wider ${
                isPassed ? "text-brand-green-dark" : "text-red-500"
              }`}
            >
              {isPassed ? "Passed" : "Failed"}
            </p>
          </div>
          {hasAnswers && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="p-1.5 rounded-lg hover:bg-brand-beige transition-colors"
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? (
                <ChevronUp size={16} className="text-brand-navy/55" />
              ) : (
                <ChevronDown size={16} className="text-brand-navy/55" />
              )}
            </button>
          )}
        </div>
      </div>

      {open && hasAnswers && (
        <div className="border-t border-brand-beige-dark px-5 py-4 space-y-2">
          <p className="text-xs font-bold text-brand-navy/55 uppercase tracking-wider mb-3">
            Your Answers
          </p>
          {attempt.answers.map((a: any) => {
            const isPending = a.isCorrect === null;
            const isCorrect = a.isCorrect === true;
            return (
              <div
                key={a.id}
                className={`flex items-start gap-3 p-3 rounded-xl border text-sm ${
                  isPending
                    ? "border-brand-beige-dark bg-brand-beige/40"
                    : isCorrect
                      ? "border-brand-green/30 bg-brand-green/5"
                      : "border-red-200 bg-red-50"
                }`}
              >
                <div
                  className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold mt-0.5 ${
                    isPending
                      ? "bg-brand-navy/40"
                      : isCorrect
                        ? "bg-brand-green-dark"
                        : "bg-red-500"
                  }`}
                >
                  {isPending ? "?" : isCorrect ? "✓" : "✗"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-brand-navy text-sm">
                    {a.questionTitle}
                  </p>
                  {a.answerText && (
                    <p className="text-xs text-brand-navy/55 mt-1 truncate">
                      "{a.answerText}"
                    </p>
                  )}
                  {isPending && (
                    <p className="text-xs text-brand-mustard mt-0.5 font-medium">
                      Pending review
                    </p>
                  )}
                </div>
                <span className="text-xs text-brand-navy/55 shrink-0 font-medium">
                  {a.pointsEarned}/{Number(a.points)} pt
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
