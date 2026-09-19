import type { Prisma } from "@prisma/client";
import { prisma } from "./db.server";

/**
 * Lessons and quizzes share one `order` sequence inside a module (the student
 * player merges and sorts them together). The admin builder shows lessons
 * first, then quizzes, so we keep that exact layout on disk: lessons get
 * 0..n-1 and quizzes n..n+m-1, each preserving its current relative order.
 *
 * Call after any create / delete / reorder in a module. Idempotent, and
 * removes the duplicate / colliding orders that count-based inserts produced.
 */
export async function normalizeModuleOrder(moduleId: string) {
  const [lessons, quizzes] = await Promise.all([
    prisma.lesson.findMany({
      where: { moduleId },
      select: { id: true, order: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.quiz.findMany({
      where: { moduleId },
      select: { id: true, order: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  lessons.forEach((l, i) => {
    if (l.order !== i)
      writes.push(prisma.lesson.update({ where: { id: l.id }, data: { order: i } }));
  });
  quizzes.forEach((q, i) => {
    const target = lessons.length + i;
    if (q.order !== target)
      writes.push(prisma.quiz.update({ where: { id: q.id }, data: { order: target } }));
  });
  if (writes.length) await prisma.$transaction(writes);
}
