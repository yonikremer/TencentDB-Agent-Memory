import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The installed `openclaw` exports map has no bare `./plugin-sdk` entry;
      // src/offload/index.ts still `await import("openclaw/plugin-sdk" as any)`
      // inside a try/catch. Vite statically resolves literal dynamic imports and
      // would hard-fail at transform time, so alias the specifier to a test stub.
      "openclaw/plugin-sdk": fileURLToPath(
        new URL("./__tests__/mocks/openclaw-plugin-sdk.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "index.ts"],
      exclude: [
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**",
      ],
    },
  },
});
