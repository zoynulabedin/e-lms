import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url: process.env["DATABASE_URL"]! },
});
