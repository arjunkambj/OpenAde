/**
 * The two conversational row kinds. Assistant text is markdown; the user's
 * bubble, with its attachments and references, lives in `user-message-row.tsx`
 * and is re-exported here beside it.
 *
 * A message that is still streaming renders in the body colour like any
 * other; what is new fades in (`markdown.tsx`). The final answer of a settled
 * turn — the row the fold gave a `turnEnd` — has the agent footer under it:
 * Copy, the time and how long the turn took. Every assistant row keeps the
 * same wrapper, so the body does not remount when a turn settles and the
 * footer appears.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import type { TurnEnd } from "@/components/timeline/fold";
import { MarkdownBody } from "@/components/timeline/markdown";
import { MessageFooter } from "@/components/timeline/message-footer";

export { UserMessageRow } from "@/components/timeline/user-message-row";

export function AssistantMessageRow({
  item,
  turnEnd,
}: {
  readonly item: ItemSnapshot;
  readonly turnEnd?: TurnEnd | undefined;
}) {
  return (
    <div className="group/message flex flex-col gap-1">
      <MarkdownBody
        text={item.text ?? ""}
        id={item.itemId}
        streaming={item.status === "in_progress"}
      />
      {turnEnd === undefined ? null : (
        <MessageFooter
          key={item.itemId}
          item={item}
          variant="agent"
          durationMs={turnEnd.durationMs}
        />
      )}
    </div>
  );
}
