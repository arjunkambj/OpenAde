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
import { sdkStreamReplayer } from "@OpenAde/testkit/replaySdkStream";

import { CLAUDE_KIND } from "../src/kind";

export interface Replay {
  readonly binaryPath: string;
  readonly pidDir: string;
  /** Every replayed process that has been started. */
  readonly pids: () => ReadonlyArray<number>;
}

export const replay = (scenario: string): Replay => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `claude-replay-${scenario}-`));
  const pidDir = NodePath.join(tmpDir, "pids");
  const { binaryPath } = sdkStreamReplayer(CLAUDE_KIND).config(scenario, { tmpDir, pidDir });
  return {
    binaryPath,
    pidDir,
    pids: () =>
      NodeFS.existsSync(pidDir) ? NodeFS.readdirSync(pidDir).map((name) => Number(name)) : [],
  };
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
