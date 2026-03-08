import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import "dotenv/config";

declare global {
  // eslint-disable-next-line no-var
  var __db: PrismaClient | undefined;
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  // Use Neon serverless adapter only for Neon-hosted databases
  if (connectionString.includes("neon.tech")) {
    const adapter = new PrismaNeon({ connectionString });
    return new PrismaClient({ adapter });
  }
  // Standard PostgreSQL (Coolify internal, Railway, etc.)
  return new PrismaClient();
}

if (!global.__db) {
  global.__db = createPrismaClient();
}

const prisma = global.__db;

export { prisma };
