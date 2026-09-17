/**
 * Sending the draft: the upload-then-dispatch chain behind Enter and the send
 * button.
 *
 * Uploads first, dispatches second — a browser `File` has no filesystem path,
 * so the server has to hold the bytes before the command can name them. A
 * failed upload leaves the draft, and the attachment, exactly where it was.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import * as React from "react";

import type { Attachments } from "@/components/composer/use-attachments";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";

/** What the composer holds when the user presses Enter. */
export interface Draft {
  readonly text: string;
  readonly mentions: ReadonlyArray<string>;
  readonly queued: boolean;
}

export interface SendDraft {
  readonly send: (draft: Draft) => void;
}

export function useSendDraft(
  threadId: ThreadId,
  attachments: Attachments,
  onError: (message: string | null) => void,
  onSent: () => void,
): SendDraft {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const onSentRef = React.useRef(onSent);
  onSentRef.current = onSent;

  const send = (draft: Draft) => {
    onErrorRef.current(null);
    void attachments
      .stage()
      .then((staged) =>
        dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.turn.start",
          threadId,
          text: draft.text,
          attachments: staged,
          mentions: [...draft.mentions],
          queued: draft.queued,
        }).then(
          (receipt) => {
            const rejected = receiptError(receipt, "the server rejected the message");
            if (rejected === null) {
              onSentRef.current();
              attachments.clear();
            }
            onErrorRef.current(rejected);
          },
          () => onErrorRef.current(DISPATCH_UNREACHABLE),
        ),
      )
      .catch(() => onErrorRef.current("the attachment could not be uploaded"));
  };

  return { send };
}
