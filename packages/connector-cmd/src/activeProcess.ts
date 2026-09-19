/**
 * The turn a session currently has running, and how its death reads.
 *
 * Its own module because session.ts has a file-size budget and this is a
 * description of state rather than of process mechanics.
 */

import type * as Deferred from "effect/Deferred";
import type * as Ref from "effect/Ref";

import type { PlanWrite } from "./plans";
import type { CmdProcess } from "./spawn";

/**
 * The live process plus two latches: `turnDone` flips when the turn's
 * completion event has been emitted — turn.completed lands on run_end while
 * the child is still a few milliseconds from reaping — and `settled` flips
 * when every post-exit side effect (onExit events, the sessionRef persist,
 * fiber teardown) has landed. A send arriving between them waits the pump
 * out instead of reporting a turn that no longer exists.
 */
export interface ActiveProcess {
  readonly proc: CmdProcess;
  readonly turnDone: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
  /** Spawned with `--permission-mode plan` — its run may leave a plan file behind. */
  readonly plan: boolean;
  /**
   * When the process was spawned. Print mode does not record its plan in
   * `plans-index.json`, so a file's mtime against this is how a plan written by
   * *this* turn is told from one sitting in the directory since last month.
   */
  readonly startedAt: number;
  /**
   * Plan files this turn's own `write_file` frames named, in arrival order.
   * The plans directory is shared by every thread and by the user's own
   * interactive runs, so this — not the newest mtime — is what says which file
   * the turn wrote.
   */
  readonly planWrites: Ref.Ref<ReadonlyArray<PlanWrite>>;
  /**
   * Tool calls this turn queued, and the hook posts answered before it began.
   *
   * The approval gate's failure mode is to open silently: a hook that does not
   * run — a path the shell mis-parsed, a script that is not executable —
   * produces no decision, and the harness falls back to its own flow, which
   * under `--yolo` allows everything. Across the 25 recorded turns that are
   * not plan turns the counts match exactly, one post per queued call, so a
   * turn that queued tools and posted nothing is the observable sign of a gate
   * that is not there. Plan mode is the one exemption: no hook fires there.
   */
  readonly queuedTools: Ref.Ref<number>;
  readonly postsAtStart: number;
  /**
   * The user asked for this one to stop. It decides how the exit reads: a
   * child we killed ourselves settles the turn `interrupted`, the same signal
   * death unasked-for is a crash the supervisor resumes from.
   */
  readonly interrupted: Ref.Ref<boolean>;
}

/**
 * Exit codes that mean "the process died on a signal": `spawnProcess` reports
 * `-1` when node hands it a null code, and 128+n is what a shell would have
 * reported for SIGKILL and SIGTERM.
 */
export const SIGNAL_DEATHS = new Set([-1, 137, 143]);
