import * as NodeURL from "node:url";
import { defineConfig } from "vitest/config";

// The gate's own rules, run by `pnpm check:boundaries` before the walk. The
// root is pinned to this directory so the suite resolves the same way from
// `--config` and as a project of the root config.
export default defineConfig({
  test: {
    name: "scripts",
    root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["*.test.mjs"],
  },
});
