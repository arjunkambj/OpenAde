/**
 * The images attached to a user message, as thumbnails above its text.
 *
 * The item carries references, not bytes — the event log would otherwise
 * re-send every screenshot on every replay — so each thumbnail asks the server
 * for its file and draws it as a `data:` URL. The request goes over the same
 * authenticated socket as everything else, which is why an attachment needs no
 * public route.
 *
 * A loaded thumbnail is a button that opens the full image in a dialog, the
 * file name as its title; Esc closes it and focus goes back to the thumbnail.
 * The dialog's open state is the thumbnail's own, keyed by the attachment's
 * path under a list keyed by the item, so a row the timeline recycles for
 * another message starts closed.
 */

import { useAtomValue } from "@effect/atom-react";
import type { Attachment } from "@poseidon/contracts/orchestration";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@poseidon/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { AsyncResult } from "effect/unstable/reactivity";

import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { useClientRuntime } from "@/lib/client-runtime";
import { cn } from "@/lib/utils";

const THUMBNAIL = "inline-flex size-20 overflow-hidden rounded-md bg-muted";

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
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex size-20 items-center justify-center overflow-hidden rounded-md bg-muted px-1 text-center text-xs leading-tight break-all text-muted-foreground" />
          }
        >
          {label}
        </TooltipTrigger>
        <TooltipContent>{label} is no longer available</TooltipContent>
      </Tooltip>
    );
  }
  if (bytes === null) {
    return <span className={THUMBNAIL} aria-label={`Loading ${label}`} role="img" />;
  }
  const src = `data:${bytes.mime};base64,${bytes.base64}`;
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <button
                  type="button"
                  aria-label={`Open ${label}`}
                  className={cn(
                    THUMBNAIL,
                    "outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  )}
                />
              }
            />
          }
        >
          <img src={src} alt="" className="size-full object-cover" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DialogContent className="w-fit max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-4rem)]">
        <DialogHeader className="mr-8 min-w-0">
          <DialogTitle>
            <span className="block truncate leading-normal">{label}</span>
          </DialogTitle>
        </DialogHeader>
        <img
          src={src}
          alt={label}
          className="max-h-[calc(100vh-8rem)] max-w-full justify-self-center rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
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
