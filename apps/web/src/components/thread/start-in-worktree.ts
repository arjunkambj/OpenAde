/**
 * Starting a thread in a new worktree, as a sequence of injected steps so the
 * order and every way out of it can be tested without a server:
 *
 * 1. create the worktree — its branch and directory are named from the first
 *    message;
 * 2. run the project's setup script there, collecting the output;
 * 3. when the script exited 0, or the project has none, create the thread
 *    with that `worktree` and send the draft as its first turn;
 * 4. otherwise stop before the thread exists, with the output and the exit
 *    status, so the user can read what went wrong and either start anyway
 *    (`finishInWorktree`) or discard the worktree.
 *
 * A failed create leaves nothing behind, so it only reports the server's
 * message. Past it the worktree exists, so every outcome carries it — the
 * caller owes the user a way to keep it or discard it.
 *
 * The user may leave the start screen at any step, and then nobody is left to
 * make that choice. Between steps the sequence asks `abandoned`: until the
 * thread exists it discards the worktree and stops; once the thread exists it
 * stops before sending, so the draft waits in the thread's own composer and
 * nothing moves the user off the page they went to.
 */

import type { WorktreeSetupProgress } from "@OpenAde/client-runtime/gitCommands";
import type { ThreadWorktree } from "@OpenAde/contracts/git";

/** Where the sequence is, for the panel above the composer. */
export type WorktreeStartStep =
  | { readonly step: "creating" }
  | { readonly step: "setup"; readonly worktree: ThreadWorktree }
  | { readonly step: "starting"; readonly worktree: ThreadWorktree };

export interface WorktreeStartSteps {
  /** Rejects with the server's refusal. */
  readonly createWorktree: () => Promise<ThreadWorktree>;
  /**
   * Resolves with the finished run. A rejection's `message` is the line shown
   * as the reason, and it may carry the `output` seen before the stream broke
   * off.
   */
  readonly runSetup: (worktree: ThreadWorktree) => Promise<WorktreeSetupProgress>;
  /** `thread.create` with the worktree; false when it was rejected (the caller has said why). */
  readonly createThread: (worktree: ThreadWorktree) => Promise<boolean>;
  readonly send: () => void;
  readonly onStep?: (step: WorktreeStartStep) => void;
  /** True once the screen that started the sequence is gone. */
  readonly abandoned?: () => boolean;
  /** Removes a worktree nobody is left to keep or discard. */
  readonly discard?: (worktree: ThreadWorktree) => Promise<void>;
}

export type WorktreeStartOutcome =
  | { readonly _tag: "started"; readonly worktree: ThreadWorktree }
  /** The worktree was never made; nothing exists to clean up. */
  | { readonly _tag: "not-created"; readonly message: string }
  | {
      readonly _tag: "setup-failed";
      readonly worktree: ThreadWorktree;
      /** One line saying how the script ended. */
      readonly reason: string;
      readonly output: string;
    }
  | { readonly _tag: "thread-rejected"; readonly worktree: ThreadWorktree }
  /**
   * The screen was left. Without a thread the worktree has been discarded;
   * with one, the draft was not sent and waits in the thread's composer.
   */
  | {
      readonly _tag: "abandoned";
      readonly worktree: ThreadWorktree;
      readonly threadCreated: boolean;
    };

/** The free text the branch is named from: the message's first non-blank line. */
export const worktreeName = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "thread";

/** A run the thread may start after: the script exited 0, or there was none. */
const setupSucceeded = (run: WorktreeSetupProgress): boolean => run.skipped || run.exit?.code === 0;

/** How a run that did not succeed ended, in one line. */
export const setupFailureReason = (run: WorktreeSetupProgress): string => {
  if (run.exit === null) {
    return "Setup script ended without an exit status";
  }
  if (run.exit.code === null) {
    return `Setup script was killed${run.exit.signal === undefined ? "" : ` (${run.exit.signal})`}`;
  }
  return `Setup script exited ${run.exit.code}`;
};

const fieldOf = (error: unknown, field: "message" | "output"): string | null =>
  typeof error === "object" &&
  error !== null &&
  field in error &&
  typeof (error as Record<string, unknown>)[field] === "string"
    ? ((error as Record<string, unknown>)[field] as string)
    : null;

const isAbandoned = (steps: WorktreeStartSteps): boolean => steps.abandoned?.() ?? false;

/** Nobody is left to choose, and there is no thread: the worktree goes. */
const leave = async (
  steps: WorktreeStartSteps,
  worktree: ThreadWorktree,
): Promise<WorktreeStartOutcome> => {
  await steps.discard?.(worktree);
  return { _tag: "abandoned", worktree, threadCreated: false };
};

/** Steps 3 and 4 on their own: what "Start anyway" runs after a failed setup. */
export const finishInWorktree = async (
  steps: WorktreeStartSteps,
  worktree: ThreadWorktree,
): Promise<WorktreeStartOutcome> => {
  if (isAbandoned(steps)) {
    return leave(steps, worktree);
  }
  steps.onStep?.({ step: "starting", worktree });
  const created = await steps.createThread(worktree);
  if (isAbandoned(steps)) {
    return created ? { _tag: "abandoned", worktree, threadCreated: true } : leave(steps, worktree);
  }
  if (!created) {
    return { _tag: "thread-rejected", worktree };
  }
  steps.send();
  return { _tag: "started", worktree };
};

export const startInWorktree = async (steps: WorktreeStartSteps): Promise<WorktreeStartOutcome> => {
  steps.onStep?.({ step: "creating" });
  let worktree: ThreadWorktree;
  try {
    worktree = await steps.createWorktree();
  } catch (error) {
    return {
      _tag: "not-created",
      message: fieldOf(error, "message") ?? "The worktree could not be created.",
    };
  }

  if (isAbandoned(steps)) {
    return leave(steps, worktree);
  }

  steps.onStep?.({ step: "setup", worktree });
  let run: WorktreeSetupProgress;
  try {
    run = await steps.runSetup(worktree);
  } catch (error) {
    if (isAbandoned(steps)) {
      return leave(steps, worktree);
    }
    return {
      _tag: "setup-failed",
      worktree,
      reason: fieldOf(error, "message") ?? "Setup script could not run",
      output: fieldOf(error, "output") ?? "",
    };
  }
  if (isAbandoned(steps)) {
    return leave(steps, worktree);
  }
  if (!setupSucceeded(run)) {
    return { _tag: "setup-failed", worktree, reason: setupFailureReason(run), output: run.output };
  }
  return finishInWorktree(steps, worktree);
};
