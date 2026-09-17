/**
 * Spawning the Command Code CLI for one headless turn.
 *
 * Spec 5.1: print mode is one turn per process — `cmd -p "<prompt>"
 * --output-format json --verbose -t --skip-onboarding --no-auto-update` plus
 * the flags a turn's settings ask for. The process runs `detached` so it leads
 * its own process group: interrupt and close signal the group (`kill(-pid)`),
 * which is the only way to take the harness's own children with it.
 *
 * `envAllowlist` is the leak guard of spec section 8: the child sees the
 * handful of variables a CLI legitimately needs, `OPENADE_*` control-plane
 * variables we set ourselves, and the operator's `extraEnv` — and nothing
 * starting with `OPENADE_SERVER_`, `ANTHROPIC_` or `OPENAI_`, ever.
 */

import { execFileSync, spawn } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// ── argv ───────────────────────────────────────────────────────

export interface BuildArgsInput {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** approvals run through our hook; `permissionMode: "plan"` replaces it. */
  readonly yolo?: boolean;
  readonly permissionMode?: "standard" | "plan" | "auto-accept";
  readonly maxTurns?: number;
  readonly addDir?: ReadonlyArray<string>;
  /** Omit the session record entirely (`--no-session`, probe turns). */
  readonly noSession?: boolean;
}

/** The headless argv of spec 5.1, in a stable order tests can assert. */
export const buildArgs = (input: BuildArgsInput): Array<string> => {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--verbose",
    "-t",
    "--skip-onboarding",
    "--no-auto-update",
  ];
  if (input.noSession === true) {
    args.push("--no-session");
  } else if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId);
  }
  if (input.model !== undefined) {
    args.push("--model", input.model);
  }
  if (input.effort !== undefined) {
    args.push("--effort", input.effort);
  }
  if (input.permissionMode !== undefined) {
    args.push("--permission-mode", input.permissionMode);
  }
  if (input.yolo === true) {
    args.push("--yolo");
  }
  if (input.maxTurns !== undefined) {
    args.push("--max-turns", String(input.maxTurns));
  }
  for (const dir of input.addDir ?? []) {
    args.push("--add-dir", dir);
  }
  return args;
};

// ── environment ────────────────────────────────────────────────

/**
 * Exact names the child always keeps. The second row is what a CLI needs to
 * reach the network and git in the real world: the ssh agent for git-over-ssh
 * inside shell commands, and the corporate-proxy variables its own API calls
 * depend on.
 */
const BASE_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * Prefixes that pass the allowlist — `LC_*` locales, Command Code's own
 * credential override, and our `OPENADE_*` control plane.
 */
const PASS_PREFIXES = ["LC_", "OPENADE_"];

/**
 * What must never reach the harness, even through `extraEnv`: our own server
 * internals and other vendors' credentials (spec section 8).
 */
const DROP_PREFIXES = ["OPENADE_SERVER_", "ANTHROPIC_", "OPENAI_"];

const isDropped = (name: string): boolean =>
  DROP_PREFIXES.some((prefix) => name.startsWith(prefix));

const isAllowed = (name: string): boolean =>
  !isDropped(name) &&
  (BASE_ENV.has(name) ||
    name === "COMMAND_CODE_API_KEY" ||
    PASS_PREFIXES.some((prefix) => name.startsWith(prefix)));

/**
 * The spawn environment: allowlisted inherited variables plus `extra` (the
 * connector's own `OPENADE_*` and the connector config's `extraEnv`), with the
 * deny prefixes applied last so nothing leaks through an override.
 */
export const envAllowlist = (
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isAllowed(name)) {
      out[name] = value;
    }
  }
  for (const [name, value] of Object.entries(extra)) {
    if (isAllowed(name)) {
      out[name] = value;
    }
  }
  return out;
};

// ── the process handle ─────────────────────────────────────────

/** The process refused to spawn or its pipes could not be wired. */
export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export interface SpawnSpec {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CmdProcess {
  readonly pid: number;
  /** Decoded UTF-8 chunks — the NDJSON stream of spec 5.2. */
  readonly stdout: Stream.Stream<string, SpawnError>;
  /** `--verbose` progress and the `session: <id>` line; drained, not parsed here. */
  readonly stderr: Stream.Stream<string, SpawnError>;
  /** Sends a signal to the whole process group. */
  readonly signal: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
  /** Resolves once with the exit code (`-1` when the process died on a signal/error). */
  readonly exitCode: Effect.Effect<number>;
  /** SIGINT to the group, SIGKILL after 5s, then a descendant sweep. */
  readonly kill: Effect.Effect<void>;
}

const KILL_GRACE = "5 seconds";

/** `kill(-pid)` reaches the group; a process that was not group leader gets the direct kill. */
const signalGroup = (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  });

/**
 * Best-effort sweep: anything still in the process group after the leader
 * died gets a direct SIGKILL. `pgrep -g` lists group members on both Linux
 * and macOS; where it does not exist the sweep quietly does nothing.
 */
const sweepGroup = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      const out = execFileSync("pgrep", ["-g", String(pid)], { encoding: "utf8" });
      for (const line of out.split("\n")) {
        const member = Number.parseInt(line.trim(), 10);
        if (Number.isFinite(member) && member > 0) {
          try {
            process.kill(member, "SIGKILL");
          } catch {
            // raced us to exit
          }
        }
      }
    } catch {
      // pgrep absent, or the group is already empty (pgrep exits 1)
    }
  });

/**
 * Spawns `spec` detached with piped stdio. The returned handle owns the
 * process: closing the surrounding scope kills it, so a leaked handle never
 * leaks a harness.
 */
export const spawnProcess = (spec: SpawnSpec): Effect.Effect<CmdProcess, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        spawn(spec.binaryPath, [...spec.args], {
          cwd: spec.cwd,
          env: { ...spec.env },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: (cause) =>
        new SpawnError({
          message: `spawn ${spec.binaryPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    // ENOENT and friends arrive on the 'error' event, not at spawn() — wait
    // for the explicit 'spawn' acknowledgement before calling it a process.
    yield* Effect.callback<void, SpawnError>((resume) => {
      const onSpawn = () => {
        child.off("error", onError);
        resume(Effect.succeed(undefined));
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        resume(
          Effect.fail(
            new SpawnError({ message: `spawn ${spec.binaryPath} failed: ${error.message}` }),
          ),
        );
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      return Effect.sync(() => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      });
    });

    const pid = child.pid;
    if (pid === undefined) {
      return yield* new SpawnError({ message: `spawn ${spec.binaryPath}: no pid` });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const exitCode = yield* Effect.cached(
      Effect.callback<number>((resume) => {
        const done = (code: number | null) => resume(Effect.succeed(code ?? -1));
        child.once("exit", done);
        child.once("error", () => done(-1));
        child.once("close", (_code, signal) => {
          // 'exit' normally beats 'close'; if only close fired, signal death
          // reports as -1 just like a missing code does.
          done(typeof _code === "number" ? _code : signal === null ? -1 : -1);
        });
        return Effect.sync(() => {
          child.off("exit", done);
        });
      }),
    );

    const signal = (signal_: "SIGINT" | "SIGTERM" | "SIGKILL"): Effect.Effect<void> =>
      signalGroup(pid, signal_);

    const kill: Effect.Effect<void> = Effect.gen(function* () {
      yield* signalGroup(pid, "SIGINT");
      const settled = yield* Effect.raceFirst(
        exitCode.pipe(Effect.as(true)),
        Effect.sleep(KILL_GRACE).pipe(Effect.as(false)),
      );
      if (!settled) {
        yield* signalGroup(pid, "SIGKILL");
      }
      yield* exitCode.pipe(Effect.ignore);
      yield* sweepGroup(pid);
    });

    // A scoped-out handle still owes the OS a dead process.
    yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore));

    const toStream = (readable: NodeJS.ReadableStream | null): Stream.Stream<string, SpawnError> =>
      readable === null
        ? Stream.empty
        : Stream.fromAsyncIterable(
            readable as AsyncIterable<string>,
            (cause) =>
              new SpawnError({
                message: `read from ${spec.binaryPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          );

    return {
      pid,
      stdout: toStream(child.stdout),
      stderr: toStream(child.stderr),
      signal,
      exitCode,
      kill,
    };
  });
