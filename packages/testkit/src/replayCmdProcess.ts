/**
 * The Command Code process, replayed.
 *
 * Spec W0/W2 asked for a `FakeCmdProcess` "to fill with captured fixtures".
 * These are the captures — `packages/testkit/fixtures/cmd/`, real runs of
 * command-code 1.55.1 — and this is what puts them back on the wire. There is
 * no stand-in CLI any more and nothing here decides anything: a test that wants
 * a different outcome names a different recording.
 *
 * Two halves:
 *
 * - `loadRecording` reads a recording so a test can assert against what the
 *   harness actually produced — the frames, the transcript, the hook payloads,
 *   the exit code.
 * - `replayConfig` gives the binary path and environment for spawning
 *   `bin/replay-cmd.mjs` as if it were `cmd`. That is the whole production round
 *   trip: real argv, real stdout chunking, a real transcript appearing on disk,
 *   the project's real hook script invoked through the system shell.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** Where the recordings live. */
export const RECORDINGS_DIR = NodePath.join(HERE, "..", "fixtures", "cmd");

/** The executable a connector instance points its binary path at. */
export const REPLAY_BINARY = NodePath.join(HERE, "..", "bin", "replay-cmd.mjs");

/** One PreToolUse invocation: what the CLI asked, and what the hook answered. */
export interface RecordedHookCall {
  readonly at: number;
  readonly stdin: {
    readonly session_id?: string;
    readonly transcript_path?: string;
    readonly cwd?: string;
    readonly hook_event_name?: string;
    readonly permission_mode?: string;
    readonly tool_use_id?: string;
    readonly tool_name?: string;
    readonly tool_display_name?: string;
    readonly tool_input?: unknown;
  };
  readonly answer: unknown;
  readonly env: Readonly<Record<string, string | null>>;
}

export interface RecordedTurn {
  readonly index: number;
  readonly prompt: string;
  /** The argv `buildArgs` produced for this run. */
  readonly connectorArgs: ReadonlyArray<string>;
  readonly sessionId: string | null;
  readonly exitCode: number;
  readonly interrupted: boolean;
  /** Every NDJSON frame, parsed, in arrival order. */
  readonly frames: ReadonlyArray<unknown>;
  readonly stderr: string;
  /** The transcript as it ended up, one parsed line per entry. */
  readonly transcript: ReadonlyArray<unknown>;
  readonly hooks: ReadonlyArray<RecordedHookCall>;
  /** Plan markdown the run left in `~/.commandcode/plans/`. */
  readonly plans: ReadonlyArray<{ readonly name: string; readonly content: string | null }>;
  /** Files in the workspace the run touched. */
  readonly touchedFiles: ReadonlyArray<{ readonly name: string; readonly content: string | null }>;
}

export interface Recording {
  readonly scenario: string;
  readonly description: string;
  readonly cliVersion: string;
  readonly model: string;
  readonly turns: ReadonlyArray<RecordedTurn>;
}

interface ManifestTurn {
  readonly index: number;
  readonly prompt: string;
  readonly connectorArgs: ReadonlyArray<string>;
  readonly sessionId: string | null;
  readonly exitCode: number;
  readonly interrupted: boolean;
  readonly plans?: ReadonlyArray<{ name: string; content: string | null }>;
  readonly touchedFiles?: ReadonlyArray<{ name: string; content: string | null }>;
  readonly files: {
    readonly stdout: string;
    readonly stderr: string;
    readonly transcript?: string;
    readonly hooks?: string;
  };
}

const read = (scenario: string, name: string | undefined, fallback = ""): string => {
  if (name === undefined) {
    return fallback;
  }
  try {
    return NodeFS.readFileSync(NodePath.join(RECORDINGS_DIR, scenario, name), "utf8");
  } catch {
    return fallback;
  }
};

const parseLines = (text: string): ReadonlyArray<unknown> =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

/**
 * Reads one recording. Throws rather than degrading: a recording that stopped
 * parsing is a recording nobody is testing against.
 */
export const loadRecording = (scenario: string): Recording => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(RECORDINGS_DIR, scenario, "manifest.json"), "utf8"),
  ) as {
    scenario: string;
    description: string;
    cliVersion: string;
    model: string;
    real: boolean;
    turns: ReadonlyArray<ManifestTurn>;
  };
  if (manifest.real !== true) {
    throw new Error(`${scenario}: not marked as a real recording`);
  }
  return {
    scenario: manifest.scenario,
    description: manifest.description,
    cliVersion: manifest.cliVersion,
    model: manifest.model,
    turns: manifest.turns.map((turn) => ({
      index: turn.index,
      prompt: turn.prompt,
      connectorArgs: turn.connectorArgs,
      sessionId: turn.sessionId,
      exitCode: turn.exitCode,
      interrupted: turn.interrupted,
      frames: parseLines(read(scenario, turn.files.stdout)),
      stderr: read(scenario, turn.files.stderr),
      transcript: parseLines(read(scenario, turn.files.transcript)),
      hooks: JSON.parse(read(scenario, turn.files.hooks, "[]")) as ReadonlyArray<RecordedHookCall>,
      plans: turn.plans ?? [],
      touchedFiles: turn.touchedFiles ?? [],
    })),
  };
};

/** Every recording on disk, by name. */
export const recordingNames = (): ReadonlyArray<string> =>
  NodeFS.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "probe")
    .map((entry) => entry.name)
    .sort();

export interface ReplayConfig {
  /** Point a connector instance's binary path here. */
  readonly binaryPath: string;
  /** Merge into the connector instance's `extraEnv`. */
  readonly extraEnv: Record<string, string>;
}

/**
 * What to spawn, and with what, to replay `scenario`.
 *
 * `home` is where the replayed transcript lands, so a test points it at a temp
 * directory and never touches the operator's `~/.commandcode`. With more than
 * one recorded turn, successive spawns play successive turns — the second
 * message of a session gets the second recorded run — unless `turn` pins one.
 */
export const replayConfig = (
  scenario: string,
  options: {
    readonly home: string;
    /** A directory the replay drops a file named after its pid into. */
    readonly pidDir?: string;
    /** Where the "which turn is next" counter lives; defaults under `home`. */
    readonly stateFile?: string;
    readonly turn?: number;
    /** File the replay appends each invocation's argv and cwd to, as JSON lines. */
    readonly argvLog?: string;
  },
): ReplayConfig => ({
  binaryPath: REPLAY_BINARY,
  extraEnv: {
    HOME: options.home,
    OPENADE_REPLAY_DIR: NodePath.join(RECORDINGS_DIR, scenario),
    OPENADE_REPLAY_STATE: options.stateFile ?? NodePath.join(options.home, ".replay-turn"),
    ...(options.pidDir === undefined ? {} : { OPENADE_REPLAY_PID_DIR: options.pidDir }),
    ...(options.turn === undefined ? {} : { OPENADE_REPLAY_TURN: String(options.turn) }),
    ...(options.argvLog === undefined ? {} : { OPENADE_REPLAY_ARGV_LOG: options.argvLog }),
  },
});

/** The argv/cwd lines a replay wrote to `argvLog`, in order. */
export const replayedInvocations = (
  argvLog: string,
): ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly cwd: string }> => {
  try {
    return NodeFS.readFileSync(argvLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { argv: ReadonlyArray<string>; cwd: string });
  } catch {
    return [];
  }
};
