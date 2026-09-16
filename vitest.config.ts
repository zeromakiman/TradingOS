import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", setupFiles:["tests/no-live-ai.ts"], include: ["tests/**/*.test.ts"], testTimeout: 30000 }
});
