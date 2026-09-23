/**
 * One terminal: a shell in a pseudo-terminal, the recent output it has
 * printed, and the hub its subscribers listen on.
 *
 * Output takes one path, all of it synchronous inside the pty's data callback:
 * the batcher coalesces it, the flush appends the batch to the scrollback and
 * then publishes it with the scrollback's new offset. Appending first is what
 * lets a subscriber that reads the scrollback after subscribing drop the
 * overlap by offset alone.
 *
 * On exit the pending batch goes out first, then the summary turns `exited`,
 * then `exited` is published — so every subscriber sees the last output before
 * the exit, and a snapshot taken after the status flipped holds all of it.
 */
import type { TerminalId, ThreadId } from "@OpenAde/contracts/ids";
import type { TerminalStreamItem, TerminalSummary } from "@OpenAde/contracts/terminal";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { makeBatcher } from "./batcher";
import type { PtyExit, PtySpawnFailed, PtyUnavailable, SpawnPtyOptions } from "./pty";
import { spawnPty } from "./pty";
import { makeScrollback } from "./scrollback";
import type { ShellCommand } from "./shell";

/** How long a shell has to go after SIGHUP before its whole process group is killed. */
const KILL_GRACE = Duration.seconds(1);

/**
 * How long to wait for the exit after SIGKILL. A SIGKILLed process always
 * exits, so this only bounds a pty whose exit notification never comes.
 */
const KILL_SETTLE = Duration.seconds(2);

export interface SessionOptions {
  readonly threadId: ThreadId;
  readonly terminalId: TerminalId;
  readonly title: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell: ShellCommand;
  readonly env: Readonly<Record<string, string>>;
  readonly spawn?: typeof spawnPty;
  readonly platform?: NodeJS.Platform;
}

export interface SessionView {
  readonly summary: TerminalSummary;
  readonly data: string;
  readonly offset: number;
  /** Set once the shell has exited; the snapshot then already holds all its output. */
  readonly exit: PtyExit | null;
}

export interface TerminalSession {
  readonly terminalId: TerminalId;
  readonly summary: () => TerminalSummary;
  /**
   * The summary, the scrollback and the exit, read together in one synchronous
   * step, so none of them can move between the three reads.
   */
  readonly view: () => SessionView;
  /** Every item after the snapshot: `output`, then one `exited`. */
  readonly hub: PubSub.PubSub<TerminalStreamItem>;
  /** A no-op once the shell has exited. */
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** Resolves with the exit; see `kill` for how long it can take. */
  readonly exited: Effect.Effect<PtyExit>;
  /**
   * Ends the shell: SIGHUP, what a closing terminal sends, then after a short
   * grace SIGKILL to the shell's whole process group — the shell leads its own
   * session, so that group is every job it started. Resolves once the exit has
   * arrived, or once the settle bound has passed.
   */
  readonly kill: Effect.Effect<void>;
}

export const makeSession = (
  options: SessionOptions,
): Effect.Effect<TerminalSession, PtyUnavailable | PtySpawnFailed> =>
  Effect.gen(function* () {
    const spawnOptions: SpawnPtyOptions = {
      file: options.shell.file,
      args: options.shell.args,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
    };
    const pty = yield* (options.spawn ?? spawnPty)(spawnOptions);
    const platform = options.platform ?? process.platform;

    const hub = yield* PubSub.unbounded<TerminalStreamItem>();
    const exitDeferred = yield* Deferred.make<PtyExit>();
    const scrollback = makeScrollback();
    let summary: TerminalSummary = {
      terminalId: options.terminalId,
      threadId: options.threadId,
      title: options.title,
      cwd: options.cwd,
      pid: pty.pid,
      cols: options.cols,
      rows: options.rows,
      status: "running",
      exitCode: null,
      createdAt: new Date().toISOString(),
    };
    let exit: PtyExit | null = null;

    const batcher = makeBatcher({
      flush: (data) => {
        scrollback.append(data);
        PubSub.publishUnsafe(hub, { kind: "output", data, offset: scrollback.offset() });
      },
    });

    const stopData = pty.onData((data) => batcher.push(data));
    const stopExit = pty.onExit((result) => {
      if (exit !== null) return;
      batcher.drain();
      batcher.dispose();
      stopData();
      stopExit();
      exit = result;
      // A shell ended by a signal has no exit code of its own; node-pty's `0`
      // there would read as success.
      const exitCode = result.signal === null ? result.exitCode : null;
      summary = { ...summary, status: "exited", exitCode };
      PubSub.publishUnsafe(hub, { kind: "exited", exitCode, signal: result.signal });
      Deferred.doneUnsafe(exitDeferred, Effect.succeed(result));
    });

    const killGroup = () => {
      if (platform === "win32") return;
      try {
        process.kill(-pty.pid, "SIGKILL");
      } catch {
        // The group is already gone, or never formed.
      }
    };

    const kill: Effect.Effect<void> = Effect.gen(function* () {
      if (exit !== null) return;
      pty.kill();
      const graceful = yield* Deferred.await(exitDeferred).pipe(Effect.timeoutOption(KILL_GRACE));
      if (Option.isSome(graceful)) return;
      killGroup();
      pty.kill("SIGKILL");
      yield* Deferred.await(exitDeferred).pipe(Effect.timeoutOption(KILL_SETTLE));
    });

    return {
      terminalId: options.terminalId,
      summary: () => summary,
      view: () => ({ summary, ...scrollback.snapshot(), exit }),
      hub,
      write: (data) => {
        if (exit === null) pty.write(data);
      },
      resize: (cols, rows) => {
        if (exit !== null) return;
        pty.resize(cols, rows);
        summary = { ...summary, cols, rows };
      },
      exited: Deferred.await(exitDeferred),
      kill,
    };
  });
