/**
 * The user's message: a bubble at the right edge holding what was attached,
 * the skills and plugins the user picked from `@` or `$`, and the text.
 *
 * The chips are the same the composer drew, so the bubble says what the turn
 * carried besides its text. A row from before references existed has none and
 * renders as it always did.
 *
 * The text renders as markdown in the `user` variant (`markdown.tsx`): lists,
 * emphasis and code format, each line ending the user typed stays a line
 * break, and raw HTML shows as typed.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { Attachments } from "@/components/timeline/attachments";
import { MarkdownBody } from "@/components/timeline/markdown";
import { Puzzle, Sparkles } from "@honeyicons/react";

function References({ item }: { readonly item: ItemSnapshot }) {
  const references = item.references ?? [];
  if (references.length === 0) {
    return null;
  }
  return (
    <span role="list" aria-label="References" className="mb-1 flex flex-wrap gap-1">
      {references.map((reference) => {
        const Icon = reference.kind === "skill" ? Sparkles : Puzzle;
        return (
          <span
            key={`${reference.kind}:${reference.name}`}
            role="listitem"
            className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 text-xs"
            title={`${reference.kind === "skill" ? "Skill" : "Plugin"} ${reference.name}`}
          >
            <Icon variant="bold" className="size-3 shrink-0 text-foreground/85" />
            <span className="truncate">{reference.name}</span>
          </span>
        );
      })}
    </span>
  );
}

export function UserMessageRow({ item }: { item: ItemSnapshot }) {
  // LegendList wraps every row in its own container, so `self-end` on the
  // bubble cannot reach the list's flex column; the row right-aligns itself.
  return (
    <div className="flex justify-end">
      <div
        aria-label="User message"
        className="max-w-[min(400px,85%)] min-w-0 rounded-xl rounded-tr-sm bg-hover px-4 py-2 text-sm leading-normal text-foreground"
      >
        <Attachments item={item} />
        <References item={item} />
        <MarkdownBody text={item.text ?? ""} id={item.itemId} variant="user" />
      </div>
    </div>
  );
}
