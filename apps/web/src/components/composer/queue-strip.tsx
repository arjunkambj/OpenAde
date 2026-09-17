/**
 * The queued-message strip. `doc.queue` is a server projection — entries land
 * via `thread.message.queued` and leave via `thread.message.dequeued`, either
 * because the next turn consumed one or because the user took it back with
 * `thread.queue.remove`. Nothing is removed locally: the row disappears when
 * the event lands, so the strip never disagrees with the server about what is
 * still going to be sent.
 *
 * Reordering is not offered — there is no command for it yet, and a drag
 * handle that silently did nothing would be worse than its absence.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ItemId, ThreadId } from "@OpenAde/contracts/ids";
import type { QueuedMessage } from "@OpenAde/contracts/orchestration";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { Icon } from "@/lib/icon";

export function QueueStrip({
  threadId,
  queue,
}: {
  readonly threadId: ThreadId;
  readonly queue: ReadonlyArray<QueuedMessage>;
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [removing, setRemoving] = React.useState<ItemId | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const remove = (queuedMessageId: ItemId) => {
    setRemoving(queuedMessageId);
    setError(null);
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.queue.remove",
      threadId,
      queuedMessageId,
    }).then(
      (receipt) => {
        setRemoving(null);
        setError(receiptError(receipt, "the server rejected the removal"));
      },
      () => {
        setRemoving(null);
        setError(DISPATCH_UNREACHABLE);
      },
    );
  };

  if (queue.length === 0) {
    return null;
  }
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2"
      aria-label="Queued messages"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon icon="hugeicons:queue-02" className="size-3.5" />
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
            {message.mentions.length + message.attachments.length > 0 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {message.mentions.length > 0 ? `@×${message.mentions.length}` : null}
                {message.attachments.length > 0 ? ` +${message.attachments.length} file(s)` : null}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-sm"
              className="shrink-0"
              aria-label={`Remove queued message ${index + 1}`}
              title="Remove from the queue"
              disabled={removing !== null}
              onClick={() => remove(message.queuedMessageId)}
            >
              <Icon icon="hugeicons:cancel-01" />
            </Button>
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
