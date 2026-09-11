import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Runtime asset data (KNOWLEDGE_DATA_DIR) can contain ingested repo copies
    // with their own *.test.ts files — never treat those as local tests.
    exclude: ["data/**", "dist/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
