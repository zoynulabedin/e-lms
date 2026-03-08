import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import "dotenv/config";

declare global {
  // eslint-disable-next-line no-var
  var __db: PrismaClient | undefined;
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  // PrismaNeon v7 accepts a PoolConfig object directly
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({ adapter });
}

if (!global.__db) {
  global.__db = createPrismaClient();
}

const prisma = global.__db;

export { prisma };
