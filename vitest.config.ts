import { defineConfig } from "vitest/config";

// One root config so `vitest` from the repository root (and IDE integrations)
// picks up every package. `pnpm test` runs the same suites through turbo.
export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/server/vitest.config.ts",
      "apps/desktop/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
  },
});
