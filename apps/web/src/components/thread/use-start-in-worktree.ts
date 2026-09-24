/**
 * The start screen's side of `start-in-worktree.ts`: binds its steps to the
 * git atoms and the caller's thread create and send, and holds where the
 * sequence is for the panel above the composer.
 *
 * The setup script's output is the setup atom's live value, so the panel
 * shows it as it arrives. Stop interrupts that atom, which ends the stream and
 * kills the script on the server; the run then reads as failed, with what it
 * printed, and the user picks between starting anyway and discarding the
 * worktree like after any other failure.
 *
 * Leaving the start screen leaves nobody to make that choice, so unmounting
 * marks the sequence abandoned (see `start-in-worktree.ts`): a running setup
 * is stopped and the worktree discarded, a failed one waiting on the user is
 * discarded, and a thread created meanwhile keeps its draft unsent instead of
 * pulling the user back to it. Each discard says so in a toast.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";
import { toast } from "sonner";

import type { ThreadWorktree } from "@OpenAde/contracts/git";
import type { ProjectId } from "@OpenAde/contracts/ids";

import { useGitCommands } from "@/components/panes/changes/git-atoms";
import {
  finishInWorktree,
  startInWorktree,
  type WorktreeStartOutcome,
  type WorktreeStartStep,
  type WorktreeStartSteps,
} from "@/components/thread/start-in-worktree";
import { describeExitError } from "@/lib/app-runtime";

export type WorktreeStartState =
  | { readonly step: "idle" }
  | WorktreeStartStep
  | {
      readonly step: "failed";
      readonly worktree: ThreadWorktree;
      readonly reason: string;
      readonly output: string;
      /** The setup ran fine but `thread.create` was refused; continuing is a retry. */
      readonly threadRejected: boolean;
    };

/** What the caller does once the worktree is ready: create the thread in it, then send. */
export interface WorktreeThreadStart {
  readonly createThread: (worktree: ThreadWorktree) => Promise<boolean>;
  readonly send: () => void;
}

const IDLE: WorktreeStartState = { step: "idle" };

export const useStartInWorktree = (projectId: ProjectId, thread: WorktreeThreadStart) => {
  const { worktreeCreate, worktreeSetupAtom, worktreeRemove: removeWorktree } = useGitCommands();
  const runSetup = useAtomSet(worktreeSetupAtom, { mode: "promiseExit" });
  const controlSetup = useAtomSet(worktreeSetupAtom);

  const live = useAtomValue(worktreeSetupAtom);
  // A stopped run is a failure that keeps the output it had so far.
  const liveOutput = Option.getOrUndefined(AsyncResult.value(live))?.output ?? "";
  const liveOutputRef = React.useRef(liveOutput);
  liveOutputRef.current = liveOutput;

  const [state, setState] = React.useState<WorktreeStartState>(IDLE);
  const stoppedRef = React.useRef(false);
  const abandonedRef = React.useRef(false);
  // A sequence is between its first step and its outcome; it checks
  // `abandonedRef` itself.
  const runningRef = React.useRef(false);
  // The worktree a failed sequence left for the user to keep or discard.
  const heldRef = React.useRef<ThreadWorktree | null>(null);

  /** The screen is gone: remove the worktree nobody is left to keep, saying so. */
  const discardAbandoned = React.useCallback(
    async (worktree: ThreadWorktree) => {
      const exit = await removeWorktree({ projectId, path: worktree.path, force: true });
      if (Exit.isSuccess(exit)) {
        toast.info(
          `Left the new thread before it started, so its worktree was removed; the branch ${worktree.branch} is kept`,
        );
      } else {
        toast.error(
          `The worktree at ${worktree.path} was not removed: ${describeExitError(exit, "unknown error")}`,
        );
      }
    },
    [projectId, removeWorktree],
  );

  // The caller's closures change every render (the draft text, the settings);
  // the steps read the latest ones when they run.
  const threadRef = React.useRef(thread);
  threadRef.current = thread;

  const steps = React.useCallback(
    (name: string, baseBranch: string | undefined): WorktreeStartSteps => ({
      createWorktree: async () => {
        const exit = await worktreeCreate({ projectId, name, baseBranch });
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      },
      runSetup: async (worktree) => {
        stoppedRef.current = false;
        const exit = await runSetup({ projectId, path: worktree.path });
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        const stopped = stoppedRef.current || Cause.hasInterruptsOnly(exit.cause);
        throw {
          message: stopped
            ? "Setup script stopped"
            : `Setup script could not run: ${describeExitError(exit, "the stream failed")}`,
          output: liveOutputRef.current,
        };
      },
      createThread: (worktree) => threadRef.current.createThread(worktree),
      send: () => threadRef.current.send(),
      onStep: setState,
      abandoned: () => abandonedRef.current,
      discard: discardAbandoned,
    }),
    [worktreeCreate, projectId, runSetup, discardAbandoned],
  );

  const settle = (outcome: WorktreeStartOutcome) => {
    if (outcome._tag === "setup-failed" || outcome._tag === "thread-rejected") {
      if (abandonedRef.current) {
        // Failed just as the screen went: nobody is left to see the panel.
        void discardAbandoned(outcome.worktree);
        return;
      }
      heldRef.current = outcome.worktree;
    }
    switch (outcome._tag) {
      case "started":
        setState(IDLE);
        return;
      case "not-created":
        toast.error(`The worktree was not created: ${outcome.message}`);
        setState(IDLE);
        return;
      case "setup-failed":
        setState({
          step: "failed",
          worktree: outcome.worktree,
          reason: outcome.reason,
          output: outcome.output,
          threadRejected: false,
        });
        return;
      case "thread-rejected":
        // `useCreateThread` has already said why in a toast.
        setState({
          step: "failed",
          worktree: outcome.worktree,
          reason: "The thread was not created",
          output: "",
          threadRejected: true,
        });
        return;
      case "abandoned":
        if (outcome.threadCreated) {
          toast.info(
            `The thread in ${outcome.worktree.branch} was created; its first message waits in its composer`,
          );
        }
    }
  };

  const sequence = async (run: () => Promise<WorktreeStartOutcome>) => {
    runningRef.current = true;
    heldRef.current = null;
    try {
      settle(await run());
    } finally {
      runningRef.current = false;
    }
  };

  const start = async (name: string, baseBranch: string | undefined) => {
    controlSetup(Atom.Reset);
    await sequence(() => startInWorktree(steps(name, baseBranch)));
  };

  const startAnyway = async (worktree: ThreadWorktree) => {
    await sequence(() => finishInWorktree(steps(worktree.branch, undefined), worktree));
  };

  // Only an unmount abandons the sequence, so the effect below must not re-run.
  const discardAbandonedRef = React.useRef(discardAbandoned);
  discardAbandonedRef.current = discardAbandoned;
  React.useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
      if (runningRef.current) {
        // The sequence discards the worktree once the interrupted setup
        // returns; the server holds that removal until the script's process
        // group has actually stopped.
        controlSetup(Atom.Interrupt);
        return;
      }
      const held = heldRef.current;
      heldRef.current = null;
      if (held !== null) {
        void discardAbandonedRef.current(held);
      }
    };
  }, [controlSetup]);

  const stop = () => {
    stoppedRef.current = true;
    controlSetup(Atom.Interrupt);
  };

  /** Removes the worktree with whatever the setup left in it; its branch stays. */
  const discard = async (worktree: ThreadWorktree) => {
    heldRef.current = null;
    const exit = await removeWorktree({ projectId, path: worktree.path, force: true });
    if (Exit.isSuccess(exit)) {
      toast.success(`Removed the worktree; the branch ${worktree.branch} is kept`);
      setState(IDLE);
    } else {
      heldRef.current = worktree;
      toast.error(describeExitError(exit, "The worktree was not removed"));
    }
  };

  return { state, liveOutput, start, startAnyway, stop, discard };
};
