import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  ssr: {
    // Ensure Node.js built-in modules are never bundled — always resolved at runtime
    noExternal: [],
    external: ["node:https", "node:http", "https", "http", "node:buffer", "node:url"],
  },
});
