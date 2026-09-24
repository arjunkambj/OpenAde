/**
 * The two conversational row kinds. Assistant text is markdown; the user's
 * bubble, with its attachments and references, lives in `user-message-row.tsx`
 * and is re-exported here beside it.
 *
 * A message that is still streaming renders in the body colour like any
 * other; what is new fades in (`markdown.tsx`).
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { MarkdownBody } from "@/components/timeline/markdown";

export { UserMessageRow } from "@/components/timeline/user-message-row";

export function AssistantMessageRow({ item }: { readonly item: ItemSnapshot }) {
  return (
    <MarkdownBody
      text={item.text ?? ""}
      id={item.itemId}
      streaming={item.status === "in_progress"}
    />
  );
}
