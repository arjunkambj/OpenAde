/**
 * The actions under a message. The `user` variant sits right-aligned under
 * the bubble: when it was sent, Copy, and "Restore to here". The `agent`
 * variant sits left-aligned under the final answer of a settled turn: Copy,
 * when the answer began, and how long the turn took.
 *
 * - The time comes from the item's UUIDv7 id — the moment the server recorded
 *   the message — shown as "14:05" with the full date in its tooltip.
 * - Copy copies the text exactly as typed, markdown and all — for an answer,
 *   its markdown source.
 * - The turn's duration is the fold's (`TurnEnd`): its first item to its
 *   last, the span the turn summary reports. No model is named: the thread's
 *   settings say which model runs now, not which one ran that turn.
 * - Restore to here puts the workspace back to how it was before the message
 *   was sent: the checkpoint of the turn before this message's turn
 *   (`checkpointBefore`), through the restore dialog. There is nothing to
 *   restore before the thread's first turn or in a workspace without git, so
 *   the button is left out there; while a turn runs, a restore is running or
 *   the server is out of reach it is disabled, and its tooltip says why.
 *
 * The row reveals the footer on hover and while focus is inside it, and a
 * coarse pointer (touch) always shows it, since there is no hover to find it
 * with. Only its opacity changes: the footer always takes its height, so a
 * hover never reflows the row the virtualizer has measured.
 *
 * The caller keys it by item id. The copy tick and the dialog's open state are
 * component state, and a recycled row must not inherit them.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { uuidV7Millis } from "@OpenAde/shared/ids";
import { Button } from "@OpenAde/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import * as React from "react";

import { CopyButton } from "@/components/copy-button";
import { RestoreCheckpointDialog } from "@/components/timeline/restore-checkpoint-dialog";
import { type TimelineThread, useTimelineThread } from "@/components/timeline/thread-context";
import { checkpointBefore, skipsTurns } from "@/components/timeline/turn-checkpoints";
import { formatClock, formatDurationMs, formatFullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Undo } from "@honeyicons/react";

function SentAt({ ms }: { readonly ms: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={new Date(ms).toISOString()}
            className="px-1 type-micro text-muted-foreground tabular-nums"
          />
        }
      >
        {formatClock(ms)}
      </TooltipTrigger>
      <TooltipContent>{formatFullDate(ms)}</TooltipContent>
    </Tooltip>
  );
}

function RestoreToHere({
  thread,
  item,
}: {
  readonly thread: TimelineThread;
  readonly item: ItemSnapshot;
}) {
  const [open, setOpen] = React.useState(false);
  const checkpoint = checkpointBefore(item.turnId, thread.turnOrder, thread.checkpoints);
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
          <Button
            type="button"
            variant="ghost"
            tone="muted"
            size="icon-xs"
            aria-label="Restore the workspace to before this message"
            disabled={blocked !== null}
            onClick={() => setOpen(true)}
          >
            <Undo variant="bold" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{blocked ?? "Restore to here"}</TooltipContent>
      </Tooltip>
      <RestoreCheckpointDialog
        open={open}
        onOpenChange={setOpen}
        threadId={thread.threadId}
        checkpoint={checkpoint}
        title="Restore to before this message?"
        description="The workspace goes back to how it was before this message was sent: every tracked file returns to that checkpoint and files created since are removed. Uncommitted work that is not in a checkpoint is lost. The conversation stays as it is."
        note={
          skipsTurns(item.turnId, thread.turnOrder, checkpoint)
            ? "The turn right before this message has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too."
            : undefined
        }
        blockedReason={blocked}
      />
    </>
  );
}

function TurnDuration({ ms }: { readonly ms: number }) {
  const duration = formatDurationMs(ms);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="px-1 type-micro text-muted-foreground tabular-nums" />}
      >
        {duration}
      </TooltipTrigger>
      <TooltipContent>{`The turn took ${duration}`}</TooltipContent>
    </Tooltip>
  );
}

// Opacity only: the footer keeps its height, so a hover never reflows the row.
const REVEAL =
  "flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 has-data-popup-open:opacity-100 motion-reduce:transition-none";

type MessageFooterProps =
  | { readonly item: ItemSnapshot; readonly variant?: "user" }
  | {
      readonly item: ItemSnapshot;
      readonly variant: "agent";
      /** How long the turn the answer ends took; nothing is shown when unknown. */
      readonly durationMs: number | undefined;
    };

export function MessageFooter(props: MessageFooterProps) {
  const { item } = props;
  const thread = useTimelineThread();
  const sentAt = uuidV7Millis(item.itemId);
  if (props.variant === "agent") {
    return (
      <div data-slot="message-footer" className={cn(REVEAL, "justify-start")}>
        <CopyButton
          text={item.text ?? ""}
          label="Copy answer"
          tooltip="Copy markdown"
          tone="muted"
        />
        {sentAt === undefined ? null : <SentAt ms={sentAt} />}
        {props.durationMs === undefined || props.durationMs <= 0 ? null : (
          <TurnDuration ms={props.durationMs} />
        )}
      </div>
    );
  }
  return (
    <div data-slot="message-footer" className={cn(REVEAL, "justify-end")}>
      {sentAt === undefined ? null : <SentAt ms={sentAt} />}
      <CopyButton text={item.text ?? ""} label="Copy message" tone="muted" />
      {thread === null ? null : <RestoreToHere thread={thread} item={item} />}
    </div>
  );
}
