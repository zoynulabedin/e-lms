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
import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

// Prefer the locally installed prisma CLI (it is a runtime dependency, so a
// production `npm ci --omit=dev` keeps it). If the install predates that
// change the folder is missing, so fall back to npx, which fetches it.
const LOCAL_PRISMA = "node_modules/prisma/build/index.js";
const PRISMA = existsSync(LOCAL_PRISMA)
  ? `node ${LOCAL_PRISMA}`
  : "npx --yes prisma@7";
if (!existsSync(LOCAL_PRISMA)) {
  console.warn(
    "[migrate] prisma is not installed locally - falling back to npx. " +
      "Run `npm install` on the server to avoid this.",
  );
}

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
      run(`${PRISMA} migrate resolve --applied ${name}`);
    }
  }
} finally {
  await pool.end();
}

// Regenerate the client BEFORE migrating. `migrate deploy` only changes the
// database; the generated client still describes whatever schema.prisma looked
// like the last time `generate` ran. A client that predates a model makes
// `prisma.thatModel` undefined, and `undefined.findMany()` is a synchronous
// TypeError that no .catch() can intercept. Prisma 7 removed the postinstall
// hook that used to cover this, so it has to be explicit.
run(`${PRISMA} generate`);
run(`${PRISMA} migrate deploy`);
