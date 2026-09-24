import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PTY_PACKAGE,
  packageRootOf,
  packagedArches,
  patchHelperPath,
  ptyPackagesFor,
} from "./native-modules.mjs";

describe("packagedArches", () => {
  it("carries both mac and windows binaries, host first", () => {
    expect(packagedArches("darwin", "arm64")).toEqual(["arm64", "x64"]);
    expect(packagedArches("darwin", "x64")).toEqual(["x64", "arm64"]);
    expect(packagedArches("win32", "x64")).toEqual(["x64", "arm64"]);
  });

  it("carries only the host's binary on linux", () => {
    expect(packagedArches("linux", "x64")).toEqual(["x64"]);
    expect(packagedArches("linux", "arm64")).toEqual(["arm64"]);
  });
});

describe("ptyPackagesFor", () => {
  it("lists the runtime loader, then one platform package per arch", () => {
    expect(ptyPackagesFor("darwin", ["arm64", "x64"])).toEqual([
      "@lydell/node-pty",
      "@lydell/node-pty-darwin-arm64",
      "@lydell/node-pty-darwin-x64",
    ]);
    expect(ptyPackagesFor("linux", ["x64", "x64"])).toEqual([
      "@lydell/node-pty",
      "@lydell/node-pty-linux-x64",
    ]);
  });

  it("names only packages the runtime package declares", () => {
    const fromServer = createRequire(
      join(import.meta.dirname, "..", "..", "server", "package.json"),
    );
    const runtime = packageRootOf(fromServer.resolve(PTY_PACKAGE), PTY_PACKAGE);
    const { optionalDependencies } = JSON.parse(
      readFileSync(join(runtime, "package.json"), "utf8"),
    );
    for (const platform of /** @type {const} */ (["darwin", "linux", "win32"])) {
      const [, ...platformPackages] = ptyPackagesFor(platform, packagedArches(platform, "x64"));
      for (const name of platformPackages) expect(optionalDependencies).toHaveProperty([name]);
    }
  });
});

describe("packageRootOf", () => {
  const store = ["", "repo", "node_modules", ".pnpm", "@lydell+node-pty@1", "node_modules"];

  it("cuts a resolved file back to its package's root", () => {
    const root = [...store, "@lydell", "node-pty"].join(sep);
    expect(packageRootOf([root, "index.js"].join(sep), "@lydell/node-pty")).toBe(root);
  });

  it("does not stop at a package whose name only starts the same", () => {
    const root = [...store, "@lydell", "node-pty-darwin-x64"].join(sep);
    const file = [root, "lib", "index.js"].join(sep);
    expect(packageRootOf(file, "@lydell/node-pty-darwin-x64")).toBe(root);
    expect(() => packageRootOf(file, "@lydell/node-pty")).toThrow(/not inside package/);
  });
});

describe("patchHelperPath", () => {
  const source = [
    "var helperPath = native.dir + '/spawn-helper';",
    "helperPath = path.resolve(__dirname, helperPath);",
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  ].join("\n");

  /** Runs the patched lines on a path, as node-pty's module would. */
  const helperFor = (dir) =>
    new Function("native", "path", "__dirname", `${patchHelperPath(source)}\nreturn helperPath;`)(
      { dir },
      { resolve: (_from, to) => to },
      "",
    );

  it("leaves a path already in app.asar.unpacked alone", () => {
    const dir = "/A/Poseidon.app/Contents/Resources/app.asar.unpacked/out/server/prebuilds";
    expect(helperFor(dir)).toBe(`${dir}/spawn-helper`);
  });

  it("still moves a path inside the archive out of it", () => {
    expect(helperFor("/R/app.asar/node_modules/x")).toBe(
      "/R/app.asar.unpacked/node_modules/x/spawn-helper",
    );
  });

  it("patches the installed platform package's own file", () => {
    const fromServer = createRequire(
      join(import.meta.dirname, "..", "..", "server", "package.json"),
    );
    const runtime = packageRootOf(fromServer.resolve(PTY_PACKAGE), PTY_PACKAGE);
    const name = `${PTY_PACKAGE}-${process.platform}-${process.arch}`;
    const platform = packageRootOf(
      createRequire(join(runtime, "package.json")).resolve(name),
      name,
    );
    const file = readFileSync(join(platform, "lib", "unixTerminal.js"), "utf8");
    expect(patchHelperPath(file)).not.toContain("replace('app.asar',");
  });

  it("refuses a file whose line has changed", () => {
    expect(() => patchHelperPath("helperPath = helperPath;")).toThrow(/revisit/);
  });
});
