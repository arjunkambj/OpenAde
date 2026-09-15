import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "connector-sdk",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
