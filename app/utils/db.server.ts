import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import "dotenv/config";

declare global {
  // eslint-disable-next-line no-var
  var __db: PrismaClient | undefined;
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  // Use Neon serverless adapter for Neon-hosted databases
  if (connectionString.includes("neon.tech")) {
    const adapter = new PrismaNeon({ connectionString });
    return new PrismaClient({ adapter });
  }
  // Standard PostgreSQL (Coolify internal, Railway, etc.)
  // Use explicit pg.Pool for the officially supported adapter API
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

if (!global.__db) {
  global.__db = createPrismaClient();
}

const prisma = global.__db;

export { prisma };
