/**
 * Binary resolution, which the probe reports and the session spawns.
 *
 * These were one function inside `probe.ts` and the session ignored it: every
 * turn spawned the bare string `"cmd"` against the server's own PATH, so a
 * packaged .app launched from Finder — launchd PATH, no `/opt/homebrew/bin` —
 * probed green and then failed the first message with ENOENT.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { BARE_CMD, extraBinDirs, NPX_PACKAGE, resolveBinary, resolveForSession } from "./binary";

/**
 * The operator's own machine has a real `cmd` in `/opt/homebrew/bin`, which is
 * one of the global dirs the resolution searches after PATH. Narrowing that
 * list to nothing is what keeps these assertions about the temp dirs below
 * rather than about whatever this machine happens to have installed.
 */
const NO_GLOBAL_DIRS: ReadonlyArray<string> = [];

const made: Array<string> = [];

const tempBinDir = (names: ReadonlyArray<string>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-binary-test-"));
  made.push(dir);
  for (const name of names) {
    NodeFS.writeFileSync(NodePath.join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBinary", () => {
  it("prefers the configured path, whatever PATH says", () => {
    const dir = tempBinDir(["cmd"]);
    expect(
      resolveBinary({ binaryPath: "/opt/elsewhere/cmd" }, { PATH: dir }, NO_GLOBAL_DIRS),
    ).toEqual({
      command: "/opt/elsewhere/cmd",
      prefixArgs: [],
      display: "/opt/elsewhere/cmd",
    });
  });

  it("resolves cmd to an absolute path, not to the bare name", () => {
    const dir = tempBinDir(["cmd"]);
    const resolved = resolveBinary({}, { PATH: dir }, NO_GLOBAL_DIRS);
    // The whole point: what the session spawns must be the file that was
    // found, so it does not have to be found again against a different PATH.
    expect(resolved?.command).toBe(NodePath.join(dir, "cmd"));
    expect(resolved?.prefixArgs).toEqual([]);
  });

  it("finds cmd in a global bin dir PATH never mentions", () => {
    // The Finder case: launchd hands the app /usr/bin:/bin:/usr/sbin:/sbin and
    // the install lives somewhere else entirely.
    const dir = tempBinDir(["cmd"]);
    const resolved = resolveBinary({}, { PATH: "/usr/bin:/bin" }, [dir]);
    expect(resolved?.command).toBe(NodePath.join(dir, "cmd"));
  });

  it("falls back to npx, resolved and with the package spec", () => {
    const dir = tempBinDir(["npx"]);
    const resolved = resolveBinary({}, { PATH: dir }, NO_GLOBAL_DIRS);
    // `command: "npx"` would be the same mistake one level down — the spawn
    // must not have to find it again.
    expect(resolved?.command).toBe(NodePath.join(dir, "npx"));
    expect(resolved?.prefixArgs).toEqual(["-y", NPX_PACKAGE]);
    expect(resolved?.display).toBe(`npx ${NPX_PACKAGE}`);
  });

  it("answers null when the machine has neither", () => {
    expect(resolveBinary({}, { PATH: tempBinDir([]) }, NO_GLOBAL_DIRS)).toBe(null);
  });

  it("gives a session the bare name only as a last resort", () => {
    const dir = tempBinDir(["cmd"]);
    expect(resolveForSession({}, { PATH: dir }, NO_GLOBAL_DIRS).command).toBe(
      NodePath.join(dir, "cmd"),
    );
    expect(resolveForSession({}, { PATH: tempBinDir([]) }, NO_GLOBAL_DIRS)).toEqual(BARE_CMD);
    expect(BARE_CMD).toEqual({ command: "cmd", prefixArgs: [], display: "cmd" });
  });

  it("searches the global bin dirs a GUI launch does not inherit", () => {
    expect(extraBinDirs()).toContain("/opt/homebrew/bin");
    expect(extraBinDirs()).toContain("/usr/local/bin");
  });
});
