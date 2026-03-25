import "dotenv/config";
import { defineConfig } from "prisma/config";

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error(
    "DATABASE_URL environment variable is not set.\n" +
    "Create a .env file in the project root with DATABASE_URL=<your-connection-string>"
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
});
