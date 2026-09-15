import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "connector-cmd",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
