/**
 * A recorded scenario, put back behind a binary path.
 *
 * The connector keeps its real SDK and its real code; only the binary changes,
 * to the testkit's replayer for `fixtures/claude/<scenario>/`. Each replayed
 * process drops a file named after its pid into `pidDir`, so a test can check
 * that every process a session started is gone.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { sdkStreamReplayer } from "@poseidon/testkit/replaySdkStream";

import { CLAUDE_KIND } from "../src/kind";

export interface Replay {
  readonly binaryPath: string;
  readonly pidDir: string;
  /** Every replayed process that has been started. */
  readonly pids: () => ReadonlyArray<number>;
  /** Throws with what the replayer said if any replayed process diverged. */
  readonly assertPlayedOut: () => void;
}

export const replay = (scenario: string): Replay => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `claude-replay-${scenario}-`));
  const pidDir = NodePath.join(tmpDir, "pids");
  const divergenceLog = NodePath.join(tmpDir, "diverged.log");
  const { binaryPath } = sdkStreamReplayer(CLAUDE_KIND).config(scenario, {
    tmpDir,
    pidDir,
    divergenceLog,
  });
  return {
    binaryPath,
    pidDir,
    pids: () =>
      NodeFS.existsSync(pidDir) ? NodeFS.readdirSync(pidDir).map((name) => Number(name)) : [],
    assertPlayedOut: () => {
      if (NodeFS.existsSync(divergenceLog)) {
        throw new Error(NodeFS.readFileSync(divergenceLog, "utf8"));
      }
    },
  };
};

/** The SDK's own version, read from the package the connector imports — for a manifest. */
export const sdkVersion = (): string => {
  const entry = NodeURL.fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(entry), "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
};

/** The process is gone: signal 0 fails with ESRCH. */
export const isPidGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/**
 * The model the CLI's `system/init` named in a raw capture — what `default`
 * resolved to on the recording account — for a manifest.
 */
export const initModelOf = (rawDir: string): string | undefined => {
  for (const name of NodeFS.readdirSync(rawDir).filter((file) => file.endsWith(".ndjson"))) {
    for (const line of NodeFS.readFileSync(NodePath.join(rawDir, name), "utf8").split("\n")) {
      if (!line.includes('"init"')) continue;
      const { data } = JSON.parse(line) as {
        data?: { type?: string; subtype?: string; model?: string };
      };
      if (data?.type === "system" && data.subtype === "init" && data.model !== undefined) {
        return data.model;
      }
    }
  }
  return undefined;
};
