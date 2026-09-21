// Read-only: mirrors what /student/resources would compute for each real learner.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const users = await p.user.findMany({ where: { role: "STUDENT" }, select: { id: true, email: true, name: true } });
console.log(`students: ${users.length}`);

const totalRes = await p.courseResource.count().catch(() => "table missing");
const activeRes = await p.courseResource.count({ where: { isActive: true } }).catch(() => "-");
const glossary = await p.glossaryTerm.count().catch(() => "table missing");
const dlLessons = await p.lesson.count({ where: { lessonType: "DOWNLOAD" } });
const dlWithUrl = await p.lesson.count({ where: { lessonType: "DOWNLOAD", resourceUrl: { not: null } } });
console.log(`\nCourseResource rows: ${totalRes} (active: ${activeRes})`);
console.log(`GlossaryTerm rows:   ${glossary}`);
console.log(`DOWNLOAD lessons:    ${dlLessons} (with a file URL: ${dlWithUrl})`);

for (const u of users) {
  const lic = await p.license.findMany({ where: { userId: u.id, status: "ACTIVE" }, select: { courseId: true }, distinct: ["courseId"] });
  const ids = lic.map(l => l.courseId);
  const res = ids.length ? await p.courseResource.count({ where: { courseId: { in: ids }, isActive: true } }).catch(() => 0) : 0;
  const dls = ids.length ? await p.lesson.count({ where: { lessonType: "DOWNLOAD", resourceUrl: { not: null }, module: { courseId: { in: ids } } } }) : 0;
  console.log(`\n${u.email}`);
  console.log(`  accessible courses: ${ids.length}`);
  console.log(`  /student/resources would show: ${res + dls} row(s)  (${res} course resources + ${dls} lesson downloads)`);
  if (res + dls === 0) console.log(`  -> the empty state: "No downloadable materials yet"`);
}
await p.$disconnect();
