import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The renderer's own `@/…` alias, so a test beside a component imports the
  // same specifier the component does. `vite.config.ts` gets it from
  // `tsconfig.json` through `resolve.tsconfigPaths`; vitest does not read that
  // config, so it is spelled out here.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
