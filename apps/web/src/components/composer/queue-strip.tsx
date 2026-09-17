/**
 * The queued-message strip. `doc.queue` is a server projection — entries land
 * via `thread.message.queued` and leave via `thread.message.dequeued` when the
 * next turn consumes them, so the strip is read-only: reorder and remove need
 * a queue command the command union does not have yet.
 */

import type { QueuedMessage } from "@OpenAde/contracts/orchestration";

import { Icon } from "@/lib/icon";

export function QueueStrip({ queue }: { readonly queue: ReadonlyArray<QueuedMessage> }) {
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
          </li>
        ))}
      </ol>
    </div>
  );
}
