/**
 * Emergency: turn off two-step verification for one account from the server
 * shell, when it can't be done in the app (e.g. the only admin lost both their
 * phone and their recovery codes). Ends that account's sessions; an admin then
 * sets two-step verification up again at the next sign-in.
 *
 *   npx tsx scripts/reset-mfa.ts someone@example.com
 *
 * Needs DATABASE_URL (read from .env like the app). Only run it after you have
 * confirmed who is asking.
 */
import "dotenv/config";
import { prisma } from "../app/utils/db.server";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: npx tsx scripts/reset-mfa.ts <email>");
  process.exit(1);
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, mfaEnabledAt: true } });
  if (!user) {
    console.error(`No account with email ${email}.`);
    process.exit(1);
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.userSession.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false } }),
  ]);
  console.log(`Two-step verification reset for ${email}${user.mfaEnabledAt ? "" : " (it was not on)"}; sessions ended.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
