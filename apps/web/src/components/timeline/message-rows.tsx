/**
 * The two conversational row kinds. User text is verbatim (`whitespace-pre-wrap`
 * — newlines the user typed are real); assistant text is markdown.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { MarkdownBody } from "@/components/timeline/markdown";
import { cn } from "@/lib/utils";

export function UserMessageRow({ item }: { item: ItemSnapshot }) {
  return (
    <div
      aria-label="User message"
      className="max-w-[min(400px,85%)] self-end rounded-xl rounded-br-md bg-hover px-4 py-2 text-sm leading-normal whitespace-pre-wrap text-foreground"
    >
      {item.text ?? ""}
    </div>
  );
}

export function AssistantMessageRow({ item }: { item: ItemSnapshot }) {
  const streaming = item.status === "in_progress";
  return (
    <MarkdownBody text={item.text ?? ""} className={cn(streaming && "text-muted-foreground")} />
  );
}
