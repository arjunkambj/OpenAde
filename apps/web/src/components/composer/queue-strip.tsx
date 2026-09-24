/**
 * The queued-message strip. `doc.queue` is a server projection — entries land
 * via `thread.message.queued` and leave via `thread.message.dequeued`, either
 * because the next turn consumed one or because the user took it back with
 * `thread.queue.remove`. Nothing is removed locally: the row disappears when
 * the event lands, so the strip never disagrees with the server about what is
 * still going to be sent.
 *
 * Reordering goes the same way: `thread.queue.reorder` names the message and
 * the position it should end up in, and the strip redraws when
 * `thread.queue.reordered` lands. Buttons rather than a drag handle — the list
 * is short, and up/down works with a keyboard and a screen reader.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { ItemId, ThreadId } from "@poseidon/contracts/ids";
import type { Command, QueuedMessage } from "@poseidon/contracts/orchestration";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { queueSummary } from "@/components/composer/queue-summary";
import { ChevronDown, ChevronUp, Close, ListOrdered } from "@honeyicons/react";

/** What a queued message carries besides its text, or nothing. */
function QueuedMessageSummary({ message }: { readonly message: QueuedMessage }) {
  const summary = queueSummary(message);
  return summary === null ? null : (
    <span className="shrink-0 text-xs text-muted-foreground">{summary}</span>
  );
}

export function QueueStrip({
  threadId,
  queue,
}: {
  readonly threadId: ThreadId;
  readonly queue: ReadonlyArray<QueuedMessage>;
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [busy, setBusy] = React.useState<ItemId | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** One dispatch, with the row locked until the receipt or the failure. */
  const send = (queuedMessageId: ItemId, command: Command, rejection: string) => {
    setBusy(queuedMessageId);
    setError(null);
    void dispatch(command).then(
      (receipt) => {
        setBusy(null);
        setError(receiptError(receipt, rejection));
      },
      () => {
        setBusy(null);
        setError(DISPATCH_UNREACHABLE);
      },
    );
  };

  const remove = (queuedMessageId: ItemId) =>
    send(
      queuedMessageId,
      {
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.queue.remove",
        threadId,
        queuedMessageId,
      },
      "the server rejected the removal",
    );

  const move = (queuedMessageId: ItemId, toIndex: number) =>
    send(
      queuedMessageId,
      {
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.queue.reorder",
        threadId,
        queuedMessageId,
        toIndex,
      },
      "the server rejected the move",
    );

  if (queue.length === 0) {
    return null;
  }
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1 rounded-xl bg-card px-3 py-2"
      aria-label="Queued messages"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ListOrdered variant="bold" className="size-3.5" />
        <span>
          {queue.length} queued {queue.length === 1 ? "message" : "messages"} — sent in order when
          the turn ends
        </span>
      </div>
      <ol className="flex min-w-0 flex-col">
        {queue.map((message, index) => (
          <li key={message.queuedMessageId} className="flex min-w-0 items-center gap-2 text-sm">
            <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{message.text}</span>
            <QueuedMessageSummary message={message} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Move queued message ${index + 1} up`}
                    disabled={busy !== null || index === 0}
                    onClick={() => move(message.queuedMessageId, index - 1)}
                  />
                }
              >
                <ChevronUp variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Send this one sooner</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Move queued message ${index + 1} down`}
                    disabled={busy !== null || index === queue.length - 1}
                    onClick={() => move(message.queuedMessageId, index + 1)}
                  />
                }
              >
                <ChevronDown variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Send this one later</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Remove queued message ${index + 1}`}
                    disabled={busy !== null}
                    onClick={() => remove(message.queuedMessageId)}
                  />
                }
              >
                <Close variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Remove from the queue</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
