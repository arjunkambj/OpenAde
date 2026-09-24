import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  KILL_SWITCH_REASON,
  REMOTE_DEBUGGING_SWITCHES,
  resolveBrowserBridge,
  stripRemoteDebugging,
} from "./browserBridge";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("resolveBrowserBridge", () => {
  it("starts the bridge by default", () => {
    expect(resolveBrowserBridge({})).toEqual({ kind: "enabled" });
  });

  it("is turned off by the kill switch", () => {
    for (const flag of ["0", "false", "FALSE", " 0 "]) {
      expect(resolveBrowserBridge({ POSEIDON_REMOTE_DEBUG: flag })).toEqual({
        kind: "disabled",
        reason: KILL_SWITCH_REASON,
      });
    }
  });

  it("ignores every other value, including the old port forms", () => {
    for (const flag of ["1", "true", "9222", ""]) {
      expect(resolveBrowserBridge({ POSEIDON_REMOTE_DEBUG: flag })).toEqual({ kind: "enabled" });
    }
    // The old opt-in no longer means anything.
    expect(resolveBrowserBridge({ POSEIDON_BROWSER_PANE: "1" })).toEqual({ kind: "enabled" });
  });
});

describe("stripRemoteDebugging", () => {
  const commandLine = (present: ReadonlyArray<string>) => {
    const switches = new Set(present);
    const calls: Array<string> = [];
    return {
      calls,
      switches,
      line: {
        hasSwitch: (name: string) => switches.has(name),
        removeSwitch: (name: string) => {
          calls.push(`remove ${name}`);
          switches.delete(name);
        },
        appendSwitch: (name: string) => calls.push(`append ${name}`),
      },
    };
  };

  it("removes every remote-debugging switch the app was launched with", () => {
    const fake = commandLine([...REMOTE_DEBUGGING_SWITCHES, "lang"]);
    expect(stripRemoteDebugging(fake.line)).toEqual([...REMOTE_DEBUGGING_SWITCHES]);
    expect([...fake.switches]).toEqual(["lang"]);
  });

  it("touches nothing on a clean command line and never appends", () => {
    const fake = commandLine([]);
    expect(stripRemoteDebugging(fake.line)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("is the only place the shell names a remote-debugging switch", () => {
    const sources: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) sources.push(path);
      }
    };
    walk(SRC);
    const appending = sources.filter((path) =>
      /appendSwitch\(\s*["'`](remote-debugging|remote-allow-origins)/.test(
        readFileSync(path, "utf8"),
      ),
    );
    expect(appending).toEqual([]);
  });
});
