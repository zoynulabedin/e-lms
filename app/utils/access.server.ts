import { data } from "react-router";
import { prisma } from "./db.server";

/**
 * Single source of truth for "can this user open this course?".
 *
 * A course is unlocked ONLY by an ACTIVE licence (a redeemed key) - whether it
 * was bought in the store or handed out by an admin as a bulk key. The course
 * type (FREE / PAID) only affects how it is presented in the catalog; it never
 * grants access by itself, so a learner who redeemed one course sees every
 * other course locked. Enrollment rows are bookkeeping created on redeem and
 * are deliberately NOT enough on their own, so revoking a licence takes
 * effect immediately.
 *
 * Used by the student course loader/action, the dashboard, the catalog and
 * the resources page so the rule can't drift between them.
 */

type CourseShape = { courseType: string; status: string };

export function computeCourseAccess(
  _course: CourseShape,
  license: { id: string } | null,
  _enrollment: { id: string } | null,
): boolean {
  return !!license;
}

export async function getCourseAccess(userId: string, courseId: string) {
  const [course, license, enrollment] = await Promise.all([
    prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, courseType: true, status: true },
    }),
    prisma.license.findFirst({
      where: { courseId, userId, status: "ACTIVE" },
      select: { id: true },
    }),
    prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { id: true },
    }),
  ]);

  const hasAccess = course
    ? computeCourseAccess(course, license, enrollment)
    : false;

  return { course, license, enrollment, hasAccess };
}

/** Throws 404 / 403 (as a Response) when the user may not touch the course. */
export async function requireCourseAccess(userId: string, courseId: string) {
  const access = await getCourseAccess(userId, courseId);
  if (!access.course)
    throw data({ message: "Course not found." }, { status: 404 });
  if (!access.hasAccess)
    throw data(
      { message: "You don't have access to this course." },
      { status: 403 },
    );
  return access;
}

/**
 * Ids of every course the user is entitled to open right now: exactly the
 * courses they hold an ACTIVE licence for. Progress/enrollment rows are
 * deliberately ignored - they only record history.
 */
export async function getAccessibleCourseIds(userId: string): Promise<string[]> {
  const licenses = await prisma.license.findMany({
    where: { userId, status: "ACTIVE" },
    select: { courseId: true },
    distinct: ["courseId"],
  });
  return licenses.map((l) => l.courseId);
}
