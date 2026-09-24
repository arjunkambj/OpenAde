/**
 * The two conversational row kinds. Assistant text is markdown; the user's
 * bubble, with its attachments and references, lives in `user-message-row.tsx`
 * and is re-exported here beside it.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { MarkdownBody } from "@/components/timeline/markdown";
import { cn } from "@/lib/utils";

export { UserMessageRow } from "@/components/timeline/user-message-row";

export function AssistantMessageRow({ item }: { item: ItemSnapshot }) {
  const streaming = item.status === "in_progress";
  return (
    <MarkdownBody
      text={item.text ?? ""}
      id={item.itemId}
      streaming={streaming}
      className={cn(streaming && "text-muted-foreground")}
    />
  );
}
