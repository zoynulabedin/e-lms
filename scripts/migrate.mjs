/**
 * Production migration runner (used by the Dockerfile CMD).
 *
 * The database was historically synced with `prisma db push`, which never
 * writes the `_prisma_migrations` table. The first `prisma migrate deploy`
 * on such a database fails with "relation already exists". This script
 * detects that situation once, marks every migration that predates the
 * switch as applied (they describe the schema the DB already has), and then
 * runs `migrate deploy` normally.
 *
 * Safe to run on every start: with a baseline in place it is just
 * `prisma migrate deploy`.
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import pg from "pg";

const { Pool } = pg;

// Migrations that existed while the DB was managed by `db push`. Everything
// after these is applied for real by `migrate deploy`.
const BASELINE_MIGRATIONS = [
  "20260305013422_add_users_progress_license_updates",
  "20260305115726_add_modules_lessons_enrollment_course_type",
  "20260305181937",
  "20260326045221_add_course_fields",
  "20260416180542_add_iframe_embed_to_lesson",
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

const run = (cmd) => {
  console.log(`[migrate] $ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const pool = new Pool({ connectionString: url });
try {
  const { rows } = await pool.query(
    `SELECT to_regclass('public."_prisma_migrations"') AS m, to_regclass('public."User"') AS u`,
  );
  const hasMigrationsTable = !!rows[0]?.m;
  const hasSchema = !!rows[0]?.u;

  if (!hasMigrationsTable && hasSchema) {
    console.log("[migrate] Existing schema without migration history detected - baselining once.");
    const present = new Set(readdirSync("prisma/migrations"));
    for (const name of BASELINE_MIGRATIONS) {
      if (!present.has(name)) continue;
      run(`npx prisma migrate resolve --applied ${name}`);
    }
  }
} finally {
  await pool.end();
}

run("npx prisma migrate deploy");
