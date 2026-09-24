/**
 * A button that restores the workspace to how it was before a turn ran —
 * "Restore to here" under a user message, "Undo" on a turn's summary card.
 * Both go back to the same place: the checkpoint of the turn before
 * (`checkpointBefore`), through the app's one restore dialog, the Changes
 * pane's (`panes/changes/restore-dialog.tsx`).
 *
 * There is nothing to restore before the thread's first turn or in a
 * workspace without git, so the button is left out there, as it is outside a
 * timeline. While a turn runs, a restore is running or the server is out of
 * reach it is disabled, and its tooltip says why. It stays focusable then
 * (`aria-disabled`, clicks ignored) and carries the reason as its
 * description, so the keyboard reaches the tooltip and a screen reader hears
 * why, not just a dimmed button. When the turn right before
 * has no checkpoint of its own the dialog falls back to an earlier one and
 * says that it undoes that turn too.
 *
 * The caller keys it by row: the dialog's open state is component state, and
 * a recycled row must not inherit it.
 */

import type { TurnId } from "@OpenAde/contracts/ids";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { RestoreCheckpointDialog } from "@/components/panes/changes/restore-dialog";
import { useTimelineThread } from "@/components/timeline/thread-context";
import { checkpointBefore, skipsTurns } from "@/components/timeline/turn-checkpoints";

export interface RestoreButtonProps {
  readonly disabled: boolean;
  /** Disabled, it keeps its focus stop: the tooltip and description say why. */
  readonly focusableWhenDisabled: true;
  readonly "aria-describedby": string | undefined;
  /** Dims it while disabled: `aria-disabled`, not the native attribute. */
  readonly className: string;
  readonly onClick: () => void;
}

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
  /** The button, spreading these props; it is also the tooltip's trigger. */
  readonly renderButton: (props: RestoreButtonProps) => React.ReactElement;
}) {
  const thread = useTimelineThread();
  const [open, setOpen] = React.useState(false);
  const reasonId = React.useId();
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
        <TooltipTrigger
          render={renderButton({
            disabled: blocked !== null,
            focusableWhenDisabled: true,
            "aria-describedby": blocked === null ? undefined : reasonId,
            className: "aria-disabled:opacity-50",
            onClick: () => setOpen(true),
          })}
        />
        <TooltipContent>{blocked ?? tooltip}</TooltipContent>
      </Tooltip>
      {blocked === null ? null : (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      )}
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
