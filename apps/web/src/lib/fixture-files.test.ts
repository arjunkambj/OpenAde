import { describe, expect, it } from "vitest";

import { FIXTURE_ROOT, fixtureStat } from "./fixture-files";

describe("fixtureStat", () => {
  it("confirms files and directories by relative or in-root absolute path", () => {
    expect(
      fixtureStat(["apps/web/src/main.tsx", "./apps/server", `${FIXTURE_ROOT}/README.md`]),
    ).toEqual([
      {
        path: "apps/web/src/main.tsx",
        relativePath: "apps/web/src/main.tsx",
        absolutePath: "/fixture/apps/web/src/main.tsx",
        isDirectory: false,
      },
      {
        path: "./apps/server",
        relativePath: "apps/server",
        absolutePath: "/fixture/apps/server",
        isDirectory: true,
      },
      {
        path: "/fixture/README.md",
        relativePath: "README.md",
        absolutePath: "/fixture/README.md",
        isDirectory: false,
      },
    ]);
  });

  it("leaves out missing, escaping and outside paths, and the root itself", () => {
    const found = fixtureStat([
      "missing.ts",
      "/etc/hosts",
      "/fixtures/README.md",
      "../README.md",
      "src/../../README.md",
      ".",
      FIXTURE_ROOT,
      "src/../README.md",
      "src/../README.md",
    ]);
    expect(found.map((stat) => stat.relativePath)).toEqual(["README.md"]);
  });
});
