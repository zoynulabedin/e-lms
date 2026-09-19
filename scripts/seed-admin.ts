/**
 * Seed script: creates the initial admin user.
 *
 * Credentials come from the environment — never hard-code them here:
 *   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='...' SEED_ADMIN_NAME='Admin' \
 *     npx tsx scripts/seed-admin.ts
 *
 * Uses the same Prisma client (pg adapter) as the app, so it works against any
 * Postgres — Neon, local, Docker.
 */
import "dotenv/config";
import { prisma } from "../app/utils/db.server";
import { hashPassword } from "../app/utils/auth.server";

const email = (process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD || "";
const name = (process.env.SEED_ADMIN_NAME || "Admin User").trim();

if (!email || !password) {
  console.error(
    "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set (see .env.example).",
  );
  process.exit(1);
}
if (password.length < 12) {
  console.error("SEED_ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin already exists: ${email}`);
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, role: "ADMIN" },
  });

  console.log("✅ Admin user created:");
  console.log(`   Email: ${email}`);
  console.log(`   ID: ${user.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
