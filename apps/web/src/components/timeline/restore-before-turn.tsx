/**
 * A button that restores the workspace to how it was before a turn ran —
 * "Restore to here" under a user message, "Undo" on a turn's summary card.
 * Both go back to the same place: the checkpoint of the turn before
 * (`checkpointBefore`), through the timeline's restore dialog.
 *
 * There is nothing to restore before the thread's first turn or in a
 * workspace without git, so the button is left out there, as it is outside a
 * timeline. While a turn runs, a restore is running or the server is out of
 * reach it is disabled, and its tooltip says why. When the turn right before
 * has no checkpoint of its own the dialog falls back to an earlier one and
 * says that it undoes that turn too.
 *
 * The caller keys it by row: the dialog's open state is component state, and
 * a recycled row must not inherit it.
 */

import type { TurnId } from "@OpenAde/contracts/ids";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { RestoreCheckpointDialog } from "@/components/timeline/restore-checkpoint-dialog";
import { useTimelineThread } from "@/components/timeline/thread-context";
import { checkpointBefore, skipsTurns } from "@/components/timeline/turn-checkpoints";

export function RestoreBeforeTurn({
  turnId,
  tooltip,
  title,
  description,
  skippedNote,
  renderButton,
}: {
  readonly turnId: TurnId | undefined;
  /** The tooltip while a restore can start; the blocked reason replaces it. */
  readonly tooltip: string;
  readonly title: string;
  readonly description: string;
  /** Shown when the checkpoint falls back past a turn that has none. */
  readonly skippedNote: string;
  readonly renderButton: (props: { disabled: boolean; onClick: () => void }) => React.ReactNode;
}) {
  const thread = useTimelineThread();
  const [open, setOpen] = React.useState(false);
  if (thread === null) {
    return null;
  }
  const checkpoint = checkpointBefore(turnId, thread.turnOrder, thread.checkpoints);
  if (checkpoint === null) {
    return null;
  }
  const blocked = thread.restoreBlockedReason;
  return (
    <>
      <Tooltip>
        {/* The trigger wraps the button: a disabled button takes no pointer
            events, and the tooltip is where it says why it is disabled. */}
        <TooltipTrigger render={<span className="inline-flex" />}>
          {renderButton({ disabled: blocked !== null, onClick: () => setOpen(true) })}
        </TooltipTrigger>
        <TooltipContent>{blocked ?? tooltip}</TooltipContent>
      </Tooltip>
      <RestoreCheckpointDialog
        open={open}
        onOpenChange={setOpen}
        threadId={thread.threadId}
        checkpoint={checkpoint}
        title={title}
        description={description}
        note={skipsTurns(turnId, thread.turnOrder, checkpoint) ? skippedNote : undefined}
        blockedReason={blocked}
      />
    </>
  );
}
