/**
 * An `sdk-stream` recording, put back on the wire as if it were the CLI.
 *
 * `bin/replay-sdk-stream.mjs` is the process; this is what points a connector
 * at it. The connector keeps its real SDK and its real code — only the binary
 * path changes — so a replay exercises the whole round trip minus the model,
 * and the model's half is the recording.
 *
 * The connector's child environment is default-deny, so nothing can reach the
 * replayer through an environment variable. `config` therefore bakes the
 * scenario into a launcher of its own, written into the test's temp directory,
 * and returns that launcher as the binary path. Each launch plays the next
 * recorded invocation of its kind — `--version`, `auth status`, or a stream-json
 * run — counted in a state file beside it, so the second session of a
 * resume-after-restart test gets the second recorded run.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { fixturesRoot, readManifest, type Replayer } from "./recording";
import { writeNodeLauncher } from "./sdkStreamRecording";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** The replaying process a launcher runs. */
const REPLAY_SCRIPT = NodePath.join(HERE, "..", "bin", "replay-sdk-stream.mjs");

/** The exit code a replay ends with when the live side stops matching the recording. */
export const REPLAY_DIVERGED = 97;

export interface SdkStreamReplayOptions {
  /** Where the launcher, its config and the invocation counter are written. */
  readonly tmpDir: string;
  /** A directory each replayed process drops a file named after its pid into. */
  readonly pidDir?: string;
}

export interface SdkStreamReplayConfig {
  /** Point the connector instance's binary path here. */
  readonly binaryPath: string;
}

/**
 * The `sdk-stream` replayer for one connector kind. `root` stands in for
 * `packages/testkit/fixtures`, for tests of the replayer itself.
 */
export const sdkStreamReplayer = (
  kind: string,
  root?: string,
): Replayer<SdkStreamReplayOptions, SdkStreamReplayConfig> => ({
  kind,
  transport: "sdk-stream",
  config: (scenario, options) => {
    // Read once here so a recording that is not real, or not this transport,
    // fails in the test that names it rather than inside a spawned child.
    const manifest = readManifest(kind, scenario, root);
    if (manifest.transport !== "sdk-stream") {
      throw new Error(`${kind}/${scenario}: recorded over ${manifest.transport}, not sdk-stream`);
    }
    const tmpDir = NodePath.resolve(options.tmpDir);
    NodeFS.mkdirSync(tmpDir, { recursive: true });
    const configFile = NodePath.join(tmpDir, `replay-${kind}-${scenario}.json`);
    NodeFS.writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          scenarioDir: NodePath.join(fixturesRoot(kind, root), scenario),
          stateFile: NodePath.join(tmpDir, `replay-${kind}-${scenario}.state.json`),
          ...(options.pidDir === undefined ? {} : { pidDir: NodePath.resolve(options.pidDir) }),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      binaryPath: writeNodeLauncher(
        NodePath.join(tmpDir, `replay-${kind}-${scenario}`),
        REPLAY_SCRIPT,
        configFile,
      ),
    };
  },
});
