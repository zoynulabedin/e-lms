/**
 * One-command health check for a deployed server.
 *
 *   npm run doctor
 *
 * Prints, in plain language:
 *   • which migrations the database has recorded (and any that FAILED)
 *   • whether every table/column the app needs is present
 *   • the result of running the /student dashboard's own queries for a real
 *     student account — the query that throws here is the one causing the 500
 *
 * Read-only: it never writes to the database.
 */
import "dotenv/config";
// pg 8.20 prints a long SSL-mode deprecation notice that buries the report.
const _warn = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  String(w).includes("SSL modes") ? undefined : _warn.call(process, w, ...rest);
import { readdirSync, existsSync } from "node:fs";
import pg from "pg";

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — run this from the application root.");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const firstLine = (m) => String(m).split(String.fromCharCode(10))[0];
const head = (m) => console.log(`\n${m}\n${"-".repeat(m.length)}`);

let problems = 0;

async function tryQuery(label, sql, params = []) {
  try {
    await pool.query(sql, params);
    ok(label);
    return true;
  } catch (e) {
    problems++;
    bad(`${label}\n      ${e.message.split("\n")[0]}`);
    return false;
  }
}

try {
  const { rows: info } = await pool.query(
    "SELECT current_database() db, version() v",
  );
  head("Database");
  console.log(`  ${info[0].db} — ${info[0].v.split(",")[0]}`);

  // ── Migration state ───────────────────────────────────────────────────────
  head("Migrations");
  const { rows: migTable } = await pool.query(
    `SELECT to_regclass('public."_prisma_migrations"') AS t`,
  );
  if (!migTable[0].t) {
    problems++;
    bad("_prisma_migrations table missing — no migration has ever been applied here");
  } else {
    const { rows } = await pool.query(
      `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, logs
         FROM "_prisma_migrations" ORDER BY started_at`,
    );
    const applied = new Set();
    for (const r of rows) {
      if (r.rolled_back_at) {
        problems++;
        bad(`${r.migration_name} — ROLLED BACK`);
      } else if (!r.finished_at) {
        problems++;
        bad(`${r.migration_name} — FAILED / unfinished`);
        if (r.logs) console.log(`      ${String(r.logs).split("\n")[0]}`);
      } else {
        applied.add(r.migration_name);
      }
    }
    const onDisk = existsSync("prisma/migrations")
      ? readdirSync("prisma/migrations", { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : [];
    const pending = onDisk.filter((n) => !applied.has(n));
    console.log(`  ${applied.size} applied, ${pending.length} pending (${onDisk.length} in this build)`);
    if (pending.length) {
      problems++;
      for (const n of pending) bad(`pending: ${n}`);
      console.log("  → run: npm run migrate:prod");
    } else {
      ok("all migrations applied");
    }
  }

  // ── Generated Prisma client ───────────────────────────────────────────────
  // The #1 cause of a route-specific 500 after a deploy: `prisma migrate
  // deploy` updates the DATABASE, but the generated client still describes the
  // schema as it was when `prisma generate` last ran. A model missing from the
  // client makes `prisma.thatModel` undefined, and `undefined.findMany()` is a
  // synchronous TypeError that no .catch() can intercept.
  head("Generated Prisma client");
  try {
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const client = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url })) });
    const required = [
      "user", "course", "module", "lesson", "quiz", "question", "answer",
      "license", "enrollment", "progress", "lessonProgress", "userSession",
      "passwordReset", "quizAttempt", "quizAttemptAnswer",
      "watchVideo", "shopifyOrder",
      // Added after the first deploy - the usual reason a feature "does
      // nothing" on the server while working locally.
      "courseResource", "glossaryTerm", "certificateTemplate",
    ];
    const missing = required.filter((m) => typeof client[m] !== "object");
    if (missing.length === 0) {
      ok(`all ${required.length} models present`);
    } else {
      problems++;
      for (const m of missing) bad(`model "${m}" MISSING from the generated client`);
      console.log("  → the client is stale. Run: npx prisma generate   (then restart the app)");
    }
    await client.$disconnect();
  } catch (e) {
    problems++;
    bad(`could not load the generated client: ${firstLine(e.message)}`);
    console.log("  → run: npx prisma generate");
  }

  // ── Schema the app depends on ─────────────────────────────────────────────
  head("Tables and columns the app needs");
  await tryQuery('table "WatchVideo"', 'SELECT 1 FROM "WatchVideo" LIMIT 1');
  await tryQuery('table "ShopifyOrder"', 'SELECT 1 FROM "ShopifyOrder" LIMIT 1');
  // Without these the Resources page and the certificate designer degrade to
  // empty rather than erroring, which looks like "the feature does nothing".
  await tryQuery('table "CourseResource"', 'SELECT 1 FROM "CourseResource" LIMIT 1');
  await tryQuery('table "GlossaryTerm"', 'SELECT 1 FROM "GlossaryTerm" LIMIT 1');
  await tryQuery('table "CertificateTemplate"', 'SELECT 1 FROM "CertificateTemplate" LIMIT 1');
  await tryQuery('column Course."iconSet"', 'SELECT "iconSet" FROM "Course" LIMIT 1');
  await tryQuery('column Course."isPublic"', 'SELECT "isPublic" FROM "Course" LIMIT 1');
  await tryQuery('column Answer."order"', 'SELECT "order" FROM "Answer" LIMIT 1');
  await tryQuery('column Lesson."iframeEmbed"', 'SELECT "iframeEmbed" FROM "Lesson" LIMIT 1');
  await tryQuery('column Progress."completedAt"', 'SELECT "completedAt" FROM "Progress" LIMIT 1');

  // ── The /student dashboard's own queries, for a real student ─────────────
  head("/student dashboard queries");
  const { rows: students } = await pool.query(
    `SELECT id, email FROM "User" WHERE role = 'STUDENT' ORDER BY "createdAt" LIMIT 1`,
  );
  if (!students.length) {
    console.log("  (no STUDENT account to test with — skipped)");
  } else {
    const uid = students[0].id;
    console.log(`  testing as ${students[0].email}`);
    await tryQuery("licences (entitlement)",
      `SELECT DISTINCT "courseId" FROM "License" WHERE "userId" = $1 AND status = 'ACTIVE'`, [uid]);
    await tryQuery("progress + course",
      `SELECT p."courseId", c.title, c.summary, c."thumbnailUrl", c."courseType", c.category
         FROM "Progress" p JOIN "Course" c ON c.id = p."courseId" WHERE p."userId" = $1`, [uid]);
    await tryQuery("enrollments + course",
      `SELECT e."courseId", c.title FROM "Enrollment" e JOIN "Course" c ON c.id = e."courseId"
        WHERE e."userId" = $1`, [uid]);
    await tryQuery("modules + lessons (resume card)",
      `SELECT m.title, l.id FROM "Module" m LEFT JOIN "Lesson" l ON l."moduleId" = m.id
        ORDER BY m."order", m."createdAt", l."order", l."createdAt" LIMIT 5`);
    await tryQuery("completed lessons",
      `SELECT lp."lessonId" FROM "LessonProgress" lp
         JOIN "Lesson" l ON l.id = lp."lessonId" JOIN "Module" m ON m.id = l."moduleId"
        WHERE lp."userId" = $1 AND lp."isCompleted" = true LIMIT 5`, [uid]);
    await tryQuery("other published courses (locked tiles)",
      `SELECT id, title, summary FROM "Course" WHERE status = 'PUBLISHED' ORDER BY "createdAt" LIMIT 5`);
    await tryQuery("watch videos",
      `SELECT "videoId", title FROM "WatchVideo" WHERE "isActive" = true ORDER BY "order" LIMIT 3`);
  }

  // ── Environment ───────────────────────────────────────────────────────────
  head("Environment");
  for (const [k, required] of [
    ["DATABASE_URL", true],
    ["JWT_SECRET", true],
    ["APP_URL", false],
    ["RESEND_API_KEY", false],
    ["CLOUDINARY_CLOUD_NAME", false],
    ["SHOPIFY_WEBHOOK_SECRET", false],
    ["TRUST_PROXY", false],
  ]) {
    const v = process.env[k];
    if (v) ok(`${k} set`);
    else if (required) { problems++; bad(`${k} MISSING`); }
    else console.log(`  - ${k} not set (optional)`);
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 16) {
    problems++;
    bad("JWT_SECRET is shorter than 16 characters — the app refuses to start in production");
  }

  head(problems === 0 ? "Result: everything checks out" : `Result: ${problems} problem(s) found`);
  if (problems === 0) {
    console.log("  The database matches this build. If a page still 500s, the cause is");
    console.log("  in the request itself — find it with the Reference code shown on the");
    console.log("  error page:  grep '<CODE>' logs/error_log");
  }
} finally {
  await pool.end();
}

process.exit(problems === 0 ? 0 : 1);
