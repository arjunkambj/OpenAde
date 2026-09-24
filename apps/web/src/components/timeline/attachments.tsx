/**
 * The images attached to a user message, as thumbnails above its text.
 *
 * The item carries references, not bytes — the event log would otherwise
 * re-send every screenshot on every replay — so each thumbnail asks the server
 * for its file and draws it as a `data:` URL. The request goes over the same
 * authenticated socket as everything else, which is why an attachment needs no
 * public route.
 */

import { useAtomValue } from "@effect/atom-react";
import type { Attachment } from "@OpenAde/contracts/orchestration";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot } from "@OpenAde/contracts/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { useClientRuntime } from "@/lib/client-runtime";

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

export function Attachments({ item }: { readonly item: ItemSnapshot }) {
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
