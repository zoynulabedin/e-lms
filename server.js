/**
 * Plesk / Passenger entry point.
 *
 * Applies any pending database migrations BEFORE the server starts, so a
 * "Restart App" in Plesk is all a deploy needs — no SSH step to forget. A
 * missing migration used to surface as a blank 500 on every page (Prisma
 * P2021 "table does not exist" / P2022 "column does not exist").
 *
 * Migrations are idempotent: with nothing pending this adds ~1s to boot.
 * Set SKIP_MIGRATE_ON_BOOT=true to opt out (e.g. when several instances of
 * the app share one database and migrations run from a deploy pipeline).
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

process.env.NODE_ENV = process.env.NODE_ENV || "production";

function runMigrations() {
  if (process.env.SKIP_MIGRATE_ON_BOOT === "true") {
    console.log("[boot] SKIP_MIGRATE_ON_BOOT=true — skipping migrations");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("[boot] DATABASE_URL is not set — skipping migrations");
    return;
  }
  if (!existsSync("./scripts/migrate.mjs")) {
    console.warn("[boot] scripts/migrate.mjs not found — skipping migrations");
    return;
  }

  console.log("[boot] applying database migrations…");
  const res = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    stdio: "inherit",
    env: process.env,
  });

  if (res.status === 0) {
    console.log("[boot] migrations up to date");
  } else {
    // Start anyway: the login page and static assets still work, and the
    // reason is now in the Plesk error log instead of a silent 500.
    console.error(
      `[boot] MIGRATIONS FAILED (exit ${res.status}). The app will start, but ` +
        "pages that use new columns/tables will return 500 until this is fixed. " +
        "Run `npm run migrate:prod` and restart.",
    );
  }
}

runMigrations();

process.argv = [process.argv[0], process.argv[1], "./build/server/index.js"];
import("./node_modules/@react-router/serve/dist/cli.js");
