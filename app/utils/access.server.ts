import { data } from "react-router";
import { prisma } from "./db.server";

/**
 * Single source of truth for "can this user open this course?".
 *
 * - PAID course  → only an ACTIVE license grants access. An Enrollment row is
 *                  created on redeem but is NOT enough on its own, so revoking
 *                  the license takes effect immediately.
 * - FREE course  → PUBLISHED courses are open to everyone; a user who enrolled
 *                  before a course was unpublished keeps access.
 *
 * Used by the student course loader/action, the dashboard, and the resources
 * page so the rule can't drift between them.
 */

type CourseShape = { courseType: string; status: string };

export function computeCourseAccess(
  course: CourseShape,
  license: { id: string } | null,
  enrollment: { id: string } | null,
): boolean {
  if (course.courseType === "PAID") return !!license;
  return course.status === "PUBLISHED" || !!enrollment;
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
 * Ids of every course the user is entitled to open right now. Progress rows
 * are deliberately ignored — they only record that a course was visited.
 */
export async function getAccessibleCourseIds(userId: string): Promise<string[]> {
  const [licenses, enrollments] = await Promise.all([
    prisma.license.findMany({
      where: { userId, status: "ACTIVE" },
      select: { courseId: true },
    }),
    prisma.enrollment.findMany({
      where: { userId },
      select: {
        courseId: true,
        course: { select: { courseType: true, status: true } },
      },
    }),
  ]);

  const ids = new Set<string>(licenses.map((l) => l.courseId));
  for (const e of enrollments) {
    if (computeCourseAccess(e.course, null, { id: "enrolled" })) {
      ids.add(e.courseId);
    }
  }
  return Array.from(ids);
}
