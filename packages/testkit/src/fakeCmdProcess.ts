/**
 * The Command Code process, without Command Code.
 *
 * W2's connector reads three things at once: NDJSON frames on stdout (spec
 * 5.2), a session transcript that the harness appends to on disk (5.3), and
 * permission hook callbacks arriving over loopback HTTP (5.5). A translator
 * that dedupes those three sources is the connector's hardest part, and it
 * cannot be tested against a CLI that needs an account and credits.
 *
 * This is the skeleton W2 fills with captured fixtures: it replays an ordered
 * script of frames, stderr lines and transcript appends, writes the transcript
 * into a temp directory as the real harness would — progressively, so a tailer
 * sees partial files — answers hook posts through a handler the test supplies,
 * and models the two ways the process dies: SIGINT leaving exit 130, SIGKILL
 * leaving exit 137.
 *
 * Deliberately not modelled: argv parsing, the `~/.commandcode` config layers,
 * and the `session:` line the real binary prints on stderr before anything
 * else — a script can emit that line itself.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { uuidV7 } from "@OpenAde/shared/ids";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Exit codes the spec pins for the two ways we end a run (5.1). */
export const EXIT_INTERRUPTED = 130;
export const EXIT_KILLED = 137;

export type FakeCmdSignal = "SIGINT" | "SIGKILL";

/**
 * One thing the fake process does, in script order. Frames and transcript
 * lines are separate steps on purpose: the overlap between the two sources,
 * and the order they arrive in, is exactly what the translator has to survive.
 */
export type FakeCmdStep =
  | { readonly kind: "frame"; readonly frame: unknown }
  | { readonly kind: "stderr"; readonly text: string }
  | { readonly kind: "transcript"; readonly line: unknown }
  | { readonly kind: "exit"; readonly code: number };

/** Answers one `PreToolUse` hook post. The default allows everything. */
export type FakeCmdHookHandler = (body: unknown) => Effect.Effect<unknown>;

export interface FakeCmdHookCall {
  readonly body: unknown;
  readonly response: unknown;
}

export class FakeCmdFixtureError extends Data.TaggedError("FakeCmdFixtureError")<{
  readonly path: string;
  readonly message: string;
}> {}

export interface FakeCmdProcessOptions {
  readonly steps: ReadonlyArray<FakeCmdStep>;
  /** Defaults to a fresh UUIDv7; the transcript is named after it. */
  readonly sessionId?: string;
  /** Where the transcript goes. A temp directory is made, and removed, by default. */
  readonly directory?: string;
  /** Recorded in the transcript header, as the harness records the run's cwd. */
  readonly cwd?: string;
  readonly hook?: FakeCmdHookHandler;
}

export interface FakeCmdProcess {
  readonly sessionId: string;
  readonly directory: string;
  readonly transcriptPath: string;
  /** stdout, one complete NDJSON line per chunk, newline included. */
  readonly stdout: Stream.Stream<string>;
  readonly stderr: Stream.Stream<string>;
  /** Plays every remaining step, then exits. */
  readonly run: Effect.Effect<void>;
  /** Plays one step. `false` once the script is spent or the process is gone. */
  readonly advance: Effect.Effect<boolean>;
  /** Resolves with the exit code once the process is gone. */
  readonly exit: Effect.Effect<number>;
  readonly signal: (signal: FakeCmdSignal) => Effect.Effect<void>;
  readonly running: Effect.Effect<boolean>;
  /** Delivers one hook post and returns what the handler answered. */
  readonly postHook: (body: unknown) => Effect.Effect<unknown>;
  readonly hookCalls: Effect.Effect<ReadonlyArray<FakeCmdHookCall>>;
  /** The transcript lines written so far, as a tailer would read them. */
  readonly transcriptLines: Effect.Effect<ReadonlyArray<string>>;
}

const ALLOW_RESPONSE = {
  hookSpecificOutput: {
    permissionDecision: "allow",
    permissionDecisionReason: "fake process allows everything by default",
  },
};

const defaultHook: FakeCmdHookHandler = () => Effect.succeed(ALLOW_RESPONSE);

/** Turns a list of NDJSON frames into the script that emits them in order. */
export const framesToSteps = (frames: ReadonlyArray<unknown>): ReadonlyArray<FakeCmdStep> =>
  frames.map((frame) => ({ kind: "frame", frame }) as const);

/**
 * Reads one NDJSON fixture from `packages/testkit/fixtures/cmd/`. Blank lines
 * are skipped; a malformed line fails rather than being dropped, because a
 * fixture that stopped parsing is a fixture nobody is testing against.
 */
export const loadCmdFixture = (
  name: string,
): Effect.Effect<ReadonlyArray<unknown>, FakeCmdFixtureError> => {
  const path = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "cmd",
    name,
  );
  return Effect.try({
    try: () =>
      NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown),
    catch: (cause) =>
      new FakeCmdFixtureError({
        path,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
};

export const makeFakeCmdProcess = (
  options: FakeCmdProcessOptions,
): Effect.Effect<FakeCmdProcess, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sessionId = options.sessionId ?? uuidV7();
    const ownsDirectory = options.directory === undefined;
    const directory =
      options.directory ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "openade-fake-cmd-"));
    if (ownsDirectory) {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      );
    } else {
      NodeFS.mkdirSync(directory, { recursive: true });
    }
    const transcriptPath = NodePath.join(directory, `${sessionId}.jsonl`);

    const stdoutQueue = yield* Queue.make<string, Cause.Done>({ capacity: 4096 });
    const stderrQueue = yield* Queue.make<string, Cause.Done>({ capacity: 1024 });
    const exitCode = yield* Deferred.make<number>();
    const cursor = yield* Ref.make(0);
    const alive = yield* Ref.make(true);
    const hookCalls = yield* Ref.make<ReadonlyArray<FakeCmdHookCall>>([]);
    const hook = options.hook ?? defaultHook;

    const appendTranscript = (line: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        NodeFS.appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`, "utf8");
      });

    // The header the harness writes before anything else (spec 5.3).
    yield* appendTranscript({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: options.cwd ?? directory,
    });

    const finish = (code: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(alive))) {
          return;
        }
        yield* Ref.set(alive, false);
        yield* Queue.end(stdoutQueue);
        yield* Queue.end(stderrQueue);
        yield* Deferred.succeed(exitCode, code);
      });

    const play = (step: FakeCmdStep): Effect.Effect<void> => {
      if (step.kind === "frame") {
        return Queue.offer(stdoutQueue, `${JSON.stringify(step.frame)}\n`).pipe(Effect.asVoid);
      }
      if (step.kind === "stderr") {
        return Queue.offer(stderrQueue, step.text).pipe(Effect.asVoid);
      }
      if (step.kind === "transcript") {
        return appendTranscript(step.line);
      }
      return finish(step.code);
    };

    const advance: Effect.Effect<boolean> = Effect.gen(function* () {
      if (!(yield* Ref.get(alive))) {
        return false;
      }
      const index = yield* Ref.modify(cursor, (current) => [current, current + 1] as const);
      const step = options.steps[index];
      if (step === undefined) {
        yield* Ref.update(cursor, (current) => current - 1);
        return false;
      }
      yield* play(step);
      return true;
    });

    const run: Effect.Effect<void> = Effect.gen(function* () {
      let more = true;
      while (more) {
        more = yield* advance;
      }
      // A script without an explicit exit step ends the way a clean run does.
      yield* finish(0);
    });

    return {
      sessionId,
      directory,
      transcriptPath,
      stdout: Stream.fromQueue(stdoutQueue),
      stderr: Stream.fromQueue(stderrQueue),
      run,
      advance,
      exit: Deferred.await(exitCode),
      signal: (signal) => finish(signal === "SIGINT" ? EXIT_INTERRUPTED : EXIT_KILLED),
      running: Ref.get(alive),
      postHook: (body) =>
        hook(body).pipe(
          Effect.tap((response) => Ref.update(hookCalls, (all) => [...all, { body, response }])),
        ),
      hookCalls: Ref.get(hookCalls),
      transcriptLines: Effect.sync(() =>
        NodeFS.readFileSync(transcriptPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0),
      ),
    };
  });
