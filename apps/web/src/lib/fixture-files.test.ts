import { describe, expect, it } from "vitest";

import { FIXTURE_ROOT, fixtureRead, fixtureStat } from "./fixture-files";

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

describe("fixtureRead", () => {
  it("answers a window of numbered lines with the file's real length", () => {
    const content = fixtureRead(`${FIXTURE_ROOT}/packages/contracts/src/rpc.ts`, 600, 3);
    expect(content).toEqual({
      path: "packages/contracts/src/rpc.ts",
      text: [601, 602, 603].map((n) => `// packages/contracts/src/rpc.ts, line ${n}`).join("\n"),
      totalLines: 760,
      truncated: false,
    });
  });

  it("stops at the end of the file, and past it answers no lines", () => {
    expect(fixtureRead("README.md", 178, 10)?.text.split("\n")).toHaveLength(2);
    expect(fixtureRead("README.md", 500, 10)?.text).toBe("");
  });

  it("has nothing for a directory, a missing file or a path outside the root", () => {
    expect(fixtureRead("apps/web")).toBeNull();
    expect(fixtureRead("missing.ts")).toBeNull();
    expect(fixtureRead("/etc/hosts")).toBeNull();
  });
});
