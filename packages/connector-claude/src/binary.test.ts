import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary, terminalCommand } from "./binary";

const dirWith = (files: Readonly<Record<string, number>>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-bin-"));
  for (const [name, mode] of Object.entries(files)) {
    const file = NodePath.join(dir, name);
    NodeFS.writeFileSync(file, "#!/bin/sh\n", "utf8");
    NodeFS.chmodSync(file, mode);
  }
  return dir;
};

describe("resolveBinary", () => {
  it("takes a configured path as given", () => {
    expect(resolveBinary({ binaryPath: "/opt/custom/claude" }, { PATH: "" }, [])).toEqual({
      command: "/opt/custom/claude",
      display: "/opt/custom/claude",
    });
  });

  it("finds claude on PATH before the extra directories", () => {
    const onPath = dirWith({ claude: 0o755 });
    const extra = dirWith({ claude: 0o755 });
    expect(resolveBinary({}, { PATH: onPath }, [extra])?.command).toBe(
      NodePath.join(onPath, "claude"),
    );
  });

  it("falls back to the install directories a GUI process never inherits", () => {
    const extra = dirWith({ claude: 0o755 });
    expect(resolveBinary({}, { PATH: "/nonexistent" }, [extra])?.command).toBe(
      NodePath.join(extra, "claude"),
    );
  });

  it("skips a file that is not executable", () => {
    const dir = dirWith({ claude: 0o644 });
    expect(resolveBinary({}, { PATH: dir }, [])).toBeNull();
  });

  it("is null when nothing is found, with no runner to fall back on", () => {
    expect(resolveBinary({ binaryPath: "" }, { PATH: "" }, [])).toBeNull();
  });
});

describe("terminalCommand", () => {
  const binary = { command: "/opt/homebrew/bin/claude", display: "/opt/homebrew/bin/claude" };

  it("spells the call against the binary that was found", () => {
    expect(terminalCommand(binary, ["auth", "login"])).toBe("/opt/homebrew/bin/claude auth login");
  });

  it("quotes a path that needs it", () => {
    expect(
      terminalCommand({ command: "/Users/me/My Tools/claude", display: "" }, ["auth", "login"]),
    ).toBe("'/Users/me/My Tools/claude' auth login");
  });

  it("names the instance's own account directory first", () => {
    expect(terminalCommand(binary, ["auth", "login"], "/Users/me/.claude-work")).toBe(
      "CLAUDE_CONFIG_DIR=/Users/me/.claude-work /opt/homebrew/bin/claude auth login",
    );
  });
});
