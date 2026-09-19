import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "connector-cmd",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * These suites spawn real `node` children — a stub `cmd`, the hook script,
     * a replayed recording — and the gate runs every package's files in
     * parallel on the same machine. At vitest's 5 s default the process-mechanics
     * tests failed roughly one run in four on a loaded laptop, always by
     * timeout and never by assertion. Nothing here waits on a clock, so a
     * generous ceiling costs a passing run nothing and only changes how long a
     * genuinely wedged test takes to say so.
     */
    testTimeout: 30_000,
  },
});
