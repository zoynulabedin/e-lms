/**
 * Collects everything needed to diagnose a problem into ONE file:
 *
 *   npm run report
 *   → writes support-report.txt in the application root
 *
 * Download that file from Plesk's File Manager (or open it in the browser-based
 * editor and copy) instead of trying to select text in the SSH terminal.
 *
 * Secrets are redacted: connection strings, API keys and tokens are masked
 * before anything is written.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "support-report.txt";
const lines = [];
const add = (s = "") => lines.push(s);
const section = (t) => {
  add("");
  add("=".repeat(72));
  add(t);
  add("=".repeat(72));
};

/** Mask anything that looks like a credential before it reaches the file. */
function redact(text) {
  return String(text)
    // postgres://user:password@host/db
    .replace(/(\w+:\/\/)[^:@\s]+:[^@\s]+@/g, "$1***:***@")
    // key=value secrets in logs / env dumps
    .replace(/((?:password|secret|token|api[_-]?key|authorization)\s*[=:]\s*)\S+/gi, "$1***")
    // long opaque strings that look like keys (re_..., shpat_..., sk_..., JWTs)
    .replace(/\b(re_|shpat_|sk_|pk_)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>");
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  return redact([r.stdout, r.stderr].filter(Boolean).join("\n").trim() || `(no output, exit ${r.status})`);
}

// ── Basics ──────────────────────────────────────────────────────────────────
section("ENVIRONMENT");
add(`generated:  ${new Date().toISOString()}`);
add(`node:       ${process.version}`);
add(`cwd:        ${process.cwd()}`);
add(`NODE_ENV:   ${process.env.NODE_ENV ?? "(unset)"}`);
add("");
add("env vars present (values hidden):");
for (const k of [
  "DATABASE_URL", "JWT_SECRET", "APP_URL", "COOKIE_SECURE", "TRUST_PROXY",
  "RESEND_API_KEY", "EMAIL_FROM", "ADMIN_EMAIL",
  "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET",
  "SHOPIFY_WEBHOOK_SECRET", "SHOPIFY_STORE_DOMAIN",
]) {
  add(`  ${process.env[k] ? "set" : "MISSING"}  ${k}`);
}

// ── Which build is actually running ─────────────────────────────────────────
section("BUILD");
const serverBundle = "build/server/index.js";
if (existsSync(serverBundle)) {
  const st = statSync(serverBundle);
  add(`${serverBundle}`);
  add(`  modified: ${st.mtime.toISOString()}`);
  add(`  size:     ${(st.size / 1024).toFixed(0)} KB`);
  const src = readFileSync(serverBundle, "utf8");
  // Markers that tell us whether recent fixes are in this bundle.
  const markers = [
    ["WatchVideo lookup failed", "dashboard survives a missing WatchVideo table"],
    ["__errorId", "error Reference codes"],
    ["Database is out of date", "schema-drift message on the error page"],
  ];
  add("");
  add("fixes present in this build:");
  for (const [needle, what] of markers) {
    add(`  ${src.includes(needle) ? "yes" : "NO "}  ${what}`);
  }
} else {
  add(`${serverBundle} NOT FOUND — the app has never been built here.`);
}
const clientDir = "build/client";
if (existsSync(clientDir)) {
  add("");
  add(`${clientDir} entries: ${readdirSync(clientDir).join(", ")}`);
  add(`.htaccess present: ${existsSync(join(clientDir, ".htaccess")) ? "yes" : "no"}`);
}

// ── Source version ──────────────────────────────────────────────────────────
section("SOURCE VERSION (git)");
add(run("git", ["log", "-1", "--pretty=%h %ad %s", "--date=iso"]));
add("");
add("uncommitted changes:");
add(run("git", ["status", "--short"]));

// ── Database / schema ───────────────────────────────────────────────────────
section("DOCTOR (database + dashboard queries)");
add(run(process.execPath, ["scripts/doctor.mjs"]));

// ── Application log ─────────────────────────────────────────────────────────
section("APPLICATION LOG (last 200 lines)");
const candidates = [
  "/var/www/vhosts/system/lms.instructionalgraphics.org/logs/error_log",
  "logs/error_log",
  "../logs/error_log",
  "../../logs/error_log",
];
const logFile = candidates.find((p) => existsSync(p));
if (!logFile) {
  add("No error_log found in the usual places:");
  for (const c of candidates) add(`  ${c}`);
  add("");
  add("Find it with:  ls /var/www/vhosts/system/*/logs/");
} else {
  add(`file: ${logFile}`);
  add("");
  const text = readFileSync(logFile, "utf8").split("\n");
  add(redact(text.slice(-200).join("\n")));
}

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`\nWrote ${OUT} (${(Buffer.byteLength(lines.join("\n")) / 1024).toFixed(0)} KB)`);
console.log("Download it from Plesk → Files, or view it with:  cat " + OUT);
console.log("Secrets (passwords, API keys, tokens) are masked.\n");
