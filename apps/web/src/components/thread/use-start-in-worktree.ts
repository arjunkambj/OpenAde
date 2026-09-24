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
    }),
    [worktreeCreate, projectId, runSetup],
  );

  const settle = (outcome: WorktreeStartOutcome) => {
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
    }
  };

  const start = async (name: string, baseBranch: string | undefined) => {
    controlSetup(Atom.Reset);
    settle(await startInWorktree(steps(name, baseBranch)));
  };

  const startAnyway = async (worktree: ThreadWorktree) => {
    settle(await finishInWorktree(steps(worktree.branch, undefined), worktree));
  };

  const stop = () => {
    stoppedRef.current = true;
    controlSetup(Atom.Interrupt);
  };

  /** Removes the worktree with whatever the setup left in it; its branch stays. */
  const discard = async (worktree: ThreadWorktree) => {
    const exit = await removeWorktree({ projectId, path: worktree.path, force: true });
    if (Exit.isSuccess(exit)) {
      toast.success(`Removed the worktree; the branch ${worktree.branch} is kept`);
      setState(IDLE);
    } else {
      toast.error(describeExitError(exit, "The worktree was not removed"));
    }
  };

  return { state, liveOutput, start, startAnyway, stop, discard };
};
