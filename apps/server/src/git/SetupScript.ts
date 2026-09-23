/**
 * A project's setup script, run in one of its new worktrees with its output
 * streamed back.
 *
 * The script is the user's own text from the settings document — `Git.ts`
 * reads it from there and checks the path is one of the project's worktrees
 * before anything here runs; a client never supplies either. It runs as
 * `/bin/sh -c <script>` in argv form with the worktree as its working
 * directory, and learns where it is from `OPENADE_WORKTREE_PATH` and
 * `OPENADE_PROJECT_ROOT`.
 *
 * The shell is spawned detached, so it leads a process group of its own, and
 * a stream that ends before the script does — the client closed the dialog,
 * the socket dropped — takes the whole group down with it: SIGTERM, then
 * SIGKILL for whatever is still there after a grace period. Killing the
 * shell alone would leave `pnpm install` or a `sleep` it started running
 * with nobody to read it.
 */
import { spawn } from "node:child_process";
import type { WorktreeSetupFrame } from "@OpenAde/contracts/git";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The most output one run streams; past it the rest is read and dropped. */
export const SETUP_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const TRUNCATED_NOTICE =
  "\n[OpenAde: the setup script's output passed 1 MiB; the rest is not shown.]\n";

/** How long the group gets to exit after SIGTERM before it is sent SIGKILL. */
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const POLL_MS = 25;

/** Whether any process of group `pgid` is still there. EPERM means one is, owned by someone else. */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
};

/** Polls until the group is empty or `ms` passes; answers whether it emptied. */
const waitForGroupExit = (pgid: number, ms: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (groupAlive(pgid)) {
      if (Date.now() >= deadline) return false;
      yield* Effect.sleep(POLL_MS);
    }
    return true;
  });

/** SIGTERM to the whole group, then SIGKILL to whatever ignored it. */
const stopGroup = (pgid: number) =>
  Effect.gen(function* () {
    signalGroup(pgid, "SIGTERM");
    if (yield* waitForGroupExit(pgid, TERM_GRACE_MS)) return;
    signalGroup(pgid, "SIGKILL");
    yield* waitForGroupExit(pgid, KILL_GRACE_MS);
  });

/**
 * Runs `script` in `cwd` and streams what it prints, then its exit. The
 * stream ends once the shell has exited and its output pipes have closed.
 */
export const runSetupScript = (options: {
  readonly script: string;
  readonly cwd: string;
  readonly projectRoot: string;
}): Stream.Stream<WorktreeSetupFrame> =>
  Stream.callback<WorktreeSetupFrame>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const state = { finished: false, sent: 0, truncated: false };
        const emit = (frame: WorktreeSetupFrame) => {
          Queue.offerUnsafe(queue, frame);
        };
        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (state.finished) return;
          state.finished = true;
          emit({ kind: "exit", exitCode, ...(signal === null ? {} : { signal }) });
          Queue.endUnsafe(queue);
        };
        const child = spawn("/bin/sh", ["-c", options.script], {
          cwd: options.cwd,
          env: {
            ...process.env,
            // `pwd` in the script answers the worktree, not the server's cwd.
            PWD: options.cwd,
            OPENADE_WORKTREE_PATH: options.cwd,
            OPENADE_PROJECT_ROOT: options.projectRoot,
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const onText = (text: string) => {
          if (state.truncated) return;
          const bytes = Buffer.byteLength(text);
          if (state.sent + bytes > SETUP_OUTPUT_LIMIT_BYTES) {
            const room = Buffer.from(text).subarray(0, SETUP_OUTPUT_LIMIT_BYTES - state.sent);
            state.sent = SETUP_OUTPUT_LIMIT_BYTES;
            state.truncated = true;
            if (room.length > 0) emit({ kind: "output", text: room.toString("utf8") });
            emit({ kind: "output", text: TRUNCATED_NOTICE });
            return;
          }
          state.sent += bytes;
          emit({ kind: "output", text });
        };
        // Decoded per pipe, so a multi-byte character split across two
        // chunks is never torn in half.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", onText);
        child.stderr.on("data", onText);
        child.on("error", (error) => {
          emit({ kind: "output", text: `Could not start the setup script: ${error.message}\n` });
          finish(null, null);
        });
        child.on("close", (code, signal) => finish(code, signal));
        return { child, state };
      }),
      ({ child, state }) =>
        // Ended before the script did: nobody is reading any more, so
        // nothing it started may keep running.
        state.finished || child.pid === undefined ? Effect.void : stopGroup(child.pid),
    ),
  );
