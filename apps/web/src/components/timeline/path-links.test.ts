import { describe, expect, it } from "vitest";

import {
  baseName,
  collectPathCandidates,
  confirmedFiles,
  inlineCodePathCandidate,
  parsePathLink,
  pathChipSuffixes,
  positionLabel,
} from "./path-links";

describe("parsePathLink", () => {
  it.each([
    ["src/app.ts", { path: "src/app.ts" }],
    ["README.md", { path: "README.md" }],
    ["./src/app.ts", { path: "./src/app.ts" }],
    ["../shared/a.ts", { path: "../shared/a.ts" }],
    ["/work/repo/src/app.ts", { path: "/work/repo/src/app.ts" }],
    ["src/app.ts:12", { path: "src/app.ts", line: 12 }],
    ["README.md:12", { path: "README.md", line: 12 }],
    ["src/app.ts:12:3", { path: "src/app.ts", line: 12, column: 3 }],
    ["src/app.ts#L12", { path: "src/app.ts", line: 12 }],
    ["src/app.ts#L12C4", { path: "src/app.ts", line: 12 }],
    ["src/app.ts#L12-L20", { path: "src/app.ts", line: 12, endLine: 20 }],
    ["src/app.ts#L12-20", { path: "src/app.ts", line: 12, endLine: 20 }],
    ["src/app.ts#L20-L12", { path: "src/app.ts", line: 20 }],
    ["docs/setup.md#install", { path: "docs/setup.md" }],
    ["src/my%20file.ts", { path: "src/my file.ts" }],
    ["file:///work/repo/src/app.ts", { path: "/work/repo/src/app.ts" }],
    ["file://localhost/work/a.ts#L3", { path: "/work/a.ts", line: 3 }],
    ["FILE:///work/a.ts", { path: "/work/a.ts" }],
    ["  src/app.ts  ", { path: "src/app.ts" }],
    ["src/app.ts:0", { path: "src/app.ts" }],
  ])("reads %s as a path", (href, expected) => {
    expect(parsePathLink(href)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "https://example.com/src/app.ts",
    "http://localhost:3000",
    "https://example.com:8080",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "vscode://file/work/a.ts",
    "C:/work/a.ts",
    "#install",
    "#L12",
    "//cdn.example.com/a.js",
    "src/app.ts?raw",
    "?tab=1",
    "~/notes.md",
    ".",
    "..",
    "file://server/share/a.ts",
    "src/%E0%A4%A.ts",
  ])("does not read %j as a path", (href) => {
    expect(parsePathLink(href)).toBeNull();
  });
});

describe("inlineCodePathCandidate", () => {
  it.each([
    ["README.md", { path: "README.md" }],
    ["package.json", { path: "package.json" }],
    ["src/app.ts", { path: "src/app.ts" }],
    ["a/b", { path: "a/b" }],
    ["apps/web/src/", { path: "apps/web/src/" }],
    ["/work/repo/src/app.ts", { path: "/work/repo/src/app.ts" }],
    ["docs/architecture.md:40", { path: "docs/architecture.md", line: 40 }],
    ["src/app.ts:12:3", { path: "src/app.ts", line: 12, column: 3 }],
    ["app/(marketing)/page.tsx", { path: "app/(marketing)/page.tsx" }],
    ["pages/[id].tsx", { path: "pages/[id].tsx" }],
    [".env.example", { path: ".env.example" }],
    ["node_modules/@scope/pkg/index.d.ts", { path: "node_modules/@scope/pkg/index.d.ts" }],
  ])("takes %s as a candidate", (text, expected) => {
    expect(inlineCodePathCandidate(text)).toEqual(expected);
  });

  it.each([
    "npm test",
    "--flag",
    "-rf",
    "src/*.ts",
    "**/*.md",
    "src/?.ts",
    "$HOME/a.ts",
    "${dir}/a.ts",
    "https://example.com/a.ts",
    "http://localhost:3000/",
    "v1.2.3",
    "1.5",
    "useState",
    "READYZ_TIMEOUT_MS",
    "a.ts; rm -rf /",
    "cat a.ts | less",
    "a=b/c.ts",
    '"src/app.ts"',
    "src\\app.ts",
    "src/app.ts#L3",
    "../..",
    "~/a.ts",
    "",
    `src/${"a".repeat(200)}.ts`,
  ])("rejects %j", (text) => {
    expect(inlineCodePathCandidate(text)).toBeNull();
  });
});

describe("collectPathCandidates", () => {
  it("gathers link targets and code spans once each, in order", () => {
    const markdown = [
      "See [main](apps/web/src/main.tsx:12) and [the readme](README.md#L3 'title').",
      "Also `src/app.ts`, `npm test`, `README.md` and [docs](https://example.com).",
      "",
      "[ref]: docs/architecture.md",
      "",
      "Twice: [main again](apps/web/src/main.tsx)",
    ].join("\n");
    expect(collectPathCandidates(markdown)).toEqual([
      "apps/web/src/main.tsx",
      "README.md",
      "docs/architecture.md",
      "src/app.ts",
    ]);
  });

  it("reads double-backtick spans and file URLs", () => {
    expect(
      collectPathCandidates("``src/a`b.ts`` and ``src/b.ts`` and [x](file:///w/c.ts#L2)"),
    ).toEqual(["/w/c.ts", "src/b.ts"]);
  });

  it("finds nothing in prose without paths", () => {
    expect(collectPathCandidates("Run `npm test` and see https://example.com.")).toEqual([]);
  });
});

describe("pathChipSuffixes", () => {
  it("leaves a unique name alone", () => {
    expect(pathChipSuffixes(["src/app.ts", "README.md"]).size).toBe(0);
  });

  it("gives two files with one name their nearest distinct parent", () => {
    expect(
      Object.fromEntries(
        pathChipSuffixes(["apps/web/src/lib/format.ts", "packages/shared/src/format.ts"]),
      ),
    ).toEqual({
      "apps/web/src/lib/format.ts": "lib/",
      "packages/shared/src/format.ts": "src/",
    });
  });

  it("climbs further while the parents still match", () => {
    expect(
      Object.fromEntries(pathChipSuffixes(["apps/web/src/index.ts", "apps/server/src/index.ts"])),
    ).toEqual({
      "apps/web/src/index.ts": "web/src/",
      "apps/server/src/index.ts": "server/src/",
    });
  });

  it("gives a file at the root no suffix beside a nested one", () => {
    expect(Object.fromEntries(pathChipSuffixes(["index.ts", "src/index.ts"]))).toEqual({
      "src/index.ts": "src/",
    });
  });
});

describe("confirmedFiles", () => {
  it("keys files by the path as asked, drops directories and adds suffixes", () => {
    const files = confirmedFiles([
      {
        path: "/w/apps/web/src/lib/format.ts",
        relativePath: "apps/web/src/lib/format.ts",
        absolutePath: "/w/apps/web/src/lib/format.ts",
        isDirectory: false,
      },
      {
        path: "packages/shared/src/format.ts",
        relativePath: "packages/shared/src/format.ts",
        absolutePath: "/w/packages/shared/src/format.ts",
        isDirectory: false,
      },
      { path: "src", relativePath: "src", absolutePath: "/w/src", isDirectory: true },
    ]);
    expect([...files.keys()]).toEqual([
      "/w/apps/web/src/lib/format.ts",
      "packages/shared/src/format.ts",
    ]);
    expect(files.get("/w/apps/web/src/lib/format.ts")).toEqual({
      relativePath: "apps/web/src/lib/format.ts",
      absolutePath: "/w/apps/web/src/lib/format.ts",
      suffix: "lib/",
    });
  });
});

describe("chip labels", () => {
  it("names a file by its last segment", () => {
    expect(baseName("apps/web/src/main.tsx")).toBe("main.tsx");
    expect(baseName("README.md")).toBe("README.md");
    expect(baseName("src/dir/")).toBe("dir");
  });

  it("writes the position after the name", () => {
    expect(positionLabel({})).toBe("");
    expect(positionLabel({ line: 12 })).toBe(":12");
    expect(positionLabel({ line: 12, column: 3 })).toBe(":12:3");
    expect(positionLabel({ line: 12, endLine: 20 })).toBe(":12–20");
  });
});
