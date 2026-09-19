import { Prisma } from "@prisma/client";
import { prisma } from "./db.server";

/**
 * Course-level progress is DERIVED: (completed lessons + passed quizzes) /
 * (all lessons + all quizzes that have at least one question). This is the
 * only place that computes it, so the student player, quiz submission, admin
 * curriculum edits and manual grading all agree.
 *
 * A quiz with no questions can never be passed, so it is excluded from the
 * denominator instead of capping everyone below 100 %.
 *
 * `completedAt` records the FIRST time the learner finished and is never
 * cleared, even if the admin later adds material and `isCompleted` drops.
 * Certificates key off `completedAt`.
 *
 * Returns null for "flat" courses (no lessons/quizzes) - those track a single
 * course-level percent via the update_progress intent instead.
 */
export async function recomputeCourseProgress(userId: string, courseId: string) {
  const [lessons, quizzes] = await Promise.all([
    prisma.lesson.findMany({
      where: { module: { courseId } },
      select: { id: true },
    }),
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT q.id FROM "Quiz" q
      JOIN "Module" m ON m.id = q."moduleId"
      WHERE m."courseId" = ${courseId}
        AND EXISTS (SELECT 1 FROM "Question" qq WHERE qq."quizId" = q.id)
    `,
  ]);

  const total = lessons.length + quizzes.length;
  if (total === 0) return null;

  const lessonIds = lessons.map((l) => l.id);
  const quizIds = quizzes.map((q) => q.id);

  const [completedLessons, passedQuizRows] = await Promise.all([
    lessonIds.length
      ? prisma.lessonProgress.count({
          where: { userId, lessonId: { in: lessonIds }, isCompleted: true },
        })
      : Promise.resolve(0),
    quizIds.length
      ? prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(DISTINCT "quizId") AS n FROM "QuizAttempt"
          WHERE "userId" = ${userId} AND "isPassed" = true
            AND "quizId" IN (${Prisma.join(quizIds)})
        `
      : Promise.resolve([{ n: BigInt(0) }]),
  ]);

  const done = completedLessons + Number(passedQuizRows[0]?.n ?? 0);
  const percent = Math.min(100, Math.round((done / total) * 100));
  const isCompleted = done >= total;

  const existing = await prisma.progress.findUnique({
    where: { userId_courseId: { userId, courseId } },
    select: { completedAt: true },
  });

  const completedAt = isCompleted
    ? (existing?.completedAt ?? new Date())
    : (existing?.completedAt ?? null);

  return prisma.progress.upsert({
    where: { userId_courseId: { userId, courseId } },
    update: { completionPercent: percent, isCompleted, completedAt, lastAccessedAt: new Date() },
    create: { userId, courseId, completionPercent: percent, isCompleted, completedAt },
  });
}

/**
 * Admin edited the curriculum (lesson/quiz added or removed): bring every
 * learner's stored percent back in line with the new totals.
 *
 * Set-based - one statement regardless of how many learners the course has,
 * so a save in the builder stays fast on a serverless Postgres.
 */
export async function recomputeCourseProgressForAllUsers(courseId: string) {
  await prisma.$executeRaw`
    WITH totals AS (
      SELECT
        (SELECT COUNT(*) FROM "Lesson" l JOIN "Module" m ON m.id = l."moduleId" WHERE m."courseId" = ${courseId})
      + (SELECT COUNT(*) FROM "Quiz" q JOIN "Module" m ON m.id = q."moduleId"
           WHERE m."courseId" = ${courseId}
             AND EXISTS (SELECT 1 FROM "Question" qq WHERE qq."quizId" = q.id)) AS total
    ),
    done AS (
      SELECT p."userId",
        (SELECT COUNT(*) FROM "LessonProgress" lp
           JOIN "Lesson" l ON l.id = lp."lessonId"
           JOIN "Module" m ON m.id = l."moduleId"
          WHERE lp."userId" = p."userId" AND lp."isCompleted" = true AND m."courseId" = ${courseId})
      + (SELECT COUNT(DISTINCT qa."quizId") FROM "QuizAttempt" qa
           JOIN "Quiz" q ON q.id = qa."quizId"
           JOIN "Module" m ON m.id = q."moduleId"
          WHERE qa."userId" = p."userId" AND qa."isPassed" = true AND m."courseId" = ${courseId}
            AND EXISTS (SELECT 1 FROM "Question" qq WHERE qq."quizId" = q.id)) AS done
      FROM "Progress" p
      WHERE p."courseId" = ${courseId}
    )
    UPDATE "Progress" p SET
      "completionPercent" = CASE WHEN t.total = 0 THEN p."completionPercent"
                                 ELSE LEAST(100, ROUND(d.done * 100.0 / t.total))::int END,
      "isCompleted"       = CASE WHEN t.total = 0 THEN p."isCompleted" ELSE d.done >= t.total END,
      "completedAt"       = CASE WHEN t.total > 0 AND d.done >= t.total AND p."completedAt" IS NULL THEN NOW()
                                 ELSE p."completedAt" END
    FROM done d, totals t
    WHERE p."userId" = d."userId" AND p."courseId" = ${courseId}
  `;
}
