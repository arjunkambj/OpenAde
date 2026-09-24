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
 * break, and raw HTML shows as typed. A long message (`user-message-collapse.ts`)
 * is clamped to ten lines that fade out at the bottom, with "Show more" under
 * it; keyboard focus moving into the clamped text opens it. Whether it is
 * open lives in the row disclosure map under `user-message:<itemId>`, so it
 * survives the row scrolling out of view and the list recycling it. Collapse-all and expand-all leave it alone: they are about
 * tool calls, not about what the user wrote.
 *
 * Under the bubble sits the message's footer (`message-footer.tsx`): the time
 * it was sent, Copy, and Restore to here, revealed on hover and focus. For a
 * message steered into a running turn, Restore goes back to before that turn.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { Button } from "@OpenAde/ui/components/button";

import { Attachments } from "@/components/timeline/attachments";
import { MarkdownBody } from "@/components/timeline/markdown";
import { MessageFooter } from "@/components/timeline/message-footer";
import { userMessageOverflows } from "@/components/timeline/user-message-collapse";
import { cn } from "@/lib/utils";
import { useRowDisclosure } from "@/state/ui";
import { ChevronDown, ChevronUp, Puzzle, Sparkles } from "@honeyicons/react";

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

function UserMessageText({ item }: { readonly item: ItemSnapshot }) {
  const text = item.text ?? "";
  const overflows = userMessageOverflows(text);
  const [open, setOpen] = useRowDisclosure(`user-message:${item.itemId}`);
  const clamped = overflows && !open;
  const bodyId = `user-message-${item.itemId}`;
  return (
    <>
      <div
        id={bodyId}
        // `overflow-clip`, not `hidden`: a hidden box is still a scroller, and
        // focus reaching a link or button below the clamp would scroll it,
        // leaving a middle slice of the text under the fade. Keyboard focus
        // inside opens the message instead, so what has focus is on screen.
        className={cn("min-w-0", clamped && "max-h-[10lh] overflow-clip mask-b-from-60%")}
        onFocus={(event) => {
          if (clamped && event.target.matches(":focus-visible")) {
            setOpen(true);
          }
        }}
      >
        <MarkdownBody text={text} id={item.itemId} variant="user" />
      </div>
      {overflows ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1 -ml-2"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show more"}
          {open ? (
            <ChevronUp variant="bold" data-icon="inline-end" />
          ) : (
            <ChevronDown variant="bold" data-icon="inline-end" />
          )}
        </Button>
      ) : null}
    </>
  );
}

export function UserMessageRow({
  item,
  steered = false,
}: {
  item: ItemSnapshot;
  /** Sent into a turn already running, which its restore goes back before. */
  steered?: boolean;
}) {
  // LegendList wraps every row in its own container, so `self-end` on the
  // bubble cannot reach the list's flex column; the row right-aligns itself.
  return (
    <div className="group/message flex flex-col items-end gap-1">
      <div
        aria-label="User message"
        className="max-w-[min(400px,85%)] min-w-0 rounded-xl rounded-tr-sm bg-hover px-4 py-2 text-sm leading-normal text-foreground"
      >
        <Attachments key={item.itemId} item={item} />
        <References item={item} />
        <UserMessageText item={item} />
      </div>
      <MessageFooter key={item.itemId} item={item} steered={steered} />
    </div>
  );
}
