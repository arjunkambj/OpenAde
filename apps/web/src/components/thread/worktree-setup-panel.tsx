/**
 * Above the start screen's composer while a thread is being started in a new
 * worktree: what is happening (creating it, running the project's setup
 * script, starting the thread) and the script's output as it arrives.
 *
 * When the script fails — or is stopped, or the thread is refused — the
 * worktree already exists, so the panel stays until the user decides: start
 * the thread there anyway, or discard the worktree. Discarding asks first and
 * removes the directory with everything the script left in it; the branch is
 * kept, as `git.worktree.remove` always does.
 */

import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@OpenAde/ui/components/alert";
import { Button } from "@OpenAde/ui/components/button";

import { ConfirmDialog } from "@/components/confirm-dialog";
import type { WorktreeStartState } from "@/components/thread/use-start-in-worktree";
import { AlertTriangle, GitFork, Spinner } from "@honeyicons/react";

function SetupOutput({ output }: { readonly output: string }) {
  const ref = React.useRef<HTMLPreElement>(null);
  // Follow the tail while the script prints, the way a terminal would.
  React.useEffect(() => {
    const element = ref.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [output]);
  if (output.length === 0) {
    return null;
  }
  return (
    <pre
      ref={ref}
      aria-label="Setup script output"
      className="mt-1.5 max-h-48 overflow-auto rounded-md bg-hover p-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground"
    >
      {output}
    </pre>
  );
}

const runningTitle = (state: WorktreeStartState): string => {
  switch (state.step) {
    case "creating":
      return "Creating worktree…";
    case "setup":
      return `Running setup script in ${state.worktree.branch}…`;
    case "starting":
      return `Starting the thread in ${state.worktree.branch}…`;
    default:
      return "";
  }
};

export function WorktreeSetupPanel({
  state,
  liveOutput,
  onStop,
  onStartAnyway,
  onDiscard,
}: {
  readonly state: WorktreeStartState;
  /** The setup script's output so far, while it runs. */
  readonly liveOutput: string;
  readonly onStop: () => void;
  readonly onStartAnyway: () => Promise<void>;
  readonly onDiscard: () => Promise<void>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [acting, setActing] = React.useState(false);

  if (state.step === "idle") {
    return null;
  }

  const act = async (action: () => Promise<void>) => {
    setActing(true);
    try {
      await action();
    } finally {
      setActing(false);
    }
  };

  if (state.step !== "failed") {
    return (
      <Alert className="w-full">
        <Spinner variant="bold" />
        <AlertTitle>{runningTitle(state)}</AlertTitle>
        <AlertDescription>
          {state.step === "setup" ? (
            <>
              <SetupOutput output={liveOutput} />
              <div className="mt-2 flex">
                <Button type="button" variant="outline" size="xs" onClick={onStop}>
                  Stop
                </Button>
              </div>
            </>
          ) : state.step === "starting" ? null : (
            "The thread gets a branch and a folder of its own."
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const { worktree } = state;
  return (
    <Alert variant="destructive" className="w-full">
      <AlertTriangle variant="bold" />
      <AlertTitle>{state.reason}</AlertTitle>
      <AlertDescription>
        {/* Wrapped rather than truncated: a no-wrap line would widen the
            alert's grid column past the composer. */}
        <span className="flex items-start gap-1.5 font-mono text-xs break-all text-muted-foreground">
          <GitFork variant="bold" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {worktree.branch} in {worktree.path}
          </span>
        </span>
        <SetupOutput output={state.output} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={acting}
            onClick={() => void act(onStartAnyway)}
          >
            {acting ? <Spinner variant="bold" /> : null}
            {state.threadRejected ? "Try again" : "Start anyway"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="xs"
            disabled={acting}
            onClick={() => setConfirming(true)}
          >
            Discard worktree
          </Button>
        </div>
      </AlertDescription>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Discard this worktree?"
        description={`The folder ${worktree.path} is removed with everything in it, including files the setup script made. The branch ${worktree.branch} is kept.`}
        confirmLabel="Discard worktree"
        onConfirm={() => void act(onDiscard)}
      />
    </Alert>
  );
}
