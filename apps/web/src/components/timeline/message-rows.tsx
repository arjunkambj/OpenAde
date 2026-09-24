/**
 * The two conversational row kinds. User text is verbatim (`whitespace-pre-wrap`
 * — newlines the user typed are real); assistant text is markdown.
 *
 * A user row also shows what was attached. The item carries references, not
 * bytes — the event log would otherwise re-send every screenshot on every
 * replay — so each thumbnail asks the server for its file and draws it as a
 * `data:` URL. The request goes over the same authenticated socket as
 * everything else, which is why an attachment needs no public route.
 *
 * It also shows the skills and plugins the user picked from `@` or `$`, as
 * the same chips the composer drew, so the bubble says what the turn carried
 * besides its text. A row from before references existed has none and renders
 * as it always did.
 */

import { useAtomValue } from "@effect/atom-react";
import type { Attachment } from "@OpenAde/contracts/orchestration";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { AsyncResult } from "effect/unstable/reactivity";

import { MarkdownBody } from "@/components/timeline/markdown";
import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { useClientRuntime } from "@/lib/client-runtime";
import { cn } from "@/lib/utils";
import { Puzzle, Sparkles } from "@honeyicons/react";

function AttachmentThumbnail({
  threadId,
  attachment,
}: {
  readonly threadId: ThreadId;
  readonly attachment: Attachment;
}) {
  const { attachmentAtom } = useClientRuntime();
  const result = useAtomValue(attachmentAtom(threadId)(attachment.path));
  const bytes = AsyncResult.isSuccess(result) ? result.value : null;
  const label = attachment.name ?? "attachment";
  // The file is gone: deleted from the attachments directory by hand, or
  // purged with an older thread. Say so, rather than leaving an empty grey
  // square that is indistinguishable from one still loading.
  if (AsyncResult.isFailure(result)) {
    return (
      <span
        className="inline-flex size-20 items-center justify-center overflow-hidden rounded-md bg-muted px-1 text-center text-xs leading-tight break-all text-muted-foreground"
        title={`${label} is no longer available`}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className="inline-flex size-20 overflow-hidden rounded-md bg-muted"
      title={bytes === null ? label : undefined}
    >
      {bytes === null ? null : (
        <img
          src={`data:${bytes.mime};base64,${bytes.base64}`}
          alt={label}
          title={label}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}

function Attachments({ item }: { readonly item: ItemSnapshot }) {
  const threadId = useTimelineThreadId();
  const attachments = item.attachments ?? [];
  if (threadId === null || attachments.length === 0) {
    return null;
  }
  return (
    <span className="mb-1 flex flex-wrap justify-end gap-1">
      {attachments.map((attachment) => (
        <AttachmentThumbnail key={attachment.path} threadId={threadId} attachment={attachment} />
      ))}
    </span>
  );
}

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
            <Icon variant="bold" className="size-3 shrink-0 text-muted-foreground" />
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
        className="max-w-[min(400px,85%)] rounded-xl rounded-tr-sm bg-hover px-4 py-2 text-sm leading-normal whitespace-pre-wrap text-foreground"
      >
        <Attachments item={item} />
        <References item={item} />
        {item.text ?? ""}
      </div>
    </div>
  );
}

export function AssistantMessageRow({ item }: { item: ItemSnapshot }) {
  const streaming = item.status === "in_progress";
  return (
    <MarkdownBody text={item.text ?? ""} className={cn(streaming && "text-muted-foreground")} />
  );
}
