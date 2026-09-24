/**
 * Sending the draft: the upload-then-dispatch chain behind Enter and the send
 * button.
 *
 * Uploads first, dispatches second — a browser `File` has no filesystem path,
 * so the server has to hold the bytes before the command can name them. A
 * failed upload leaves the draft, and the attachment, exactly where it was.
 *
 * One send at a time. An upload can take seconds, and the draft stays on
 * screen while it runs, so a second Enter (or a second click) would otherwise
 * upload the same images again and start a second real turn — the user's model
 * credits, spent twice for one message. The latch is a ref as well as state:
 * the ref closes the window before React has re-rendered the disabled button.
 *
 * The draft's `mode` (`./send-mode`) picks the command: `thread.turn.steer`
 * delivers into the running turn, `thread.turn.start` starts one or, with
 * `queued`, waits behind it.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { TurnReference } from "@OpenAde/contracts/runtime";
import * as React from "react";

import type { SendMode } from "@/components/composer/send-mode";
import type { Attachments } from "@/components/composer/use-attachments";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";

/** What the composer holds when the user presses Enter. */
export interface Draft {
  readonly text: string;
  readonly mentions: ReadonlyArray<string>;
  readonly mode: SendMode;
  /** Skills and plugins picked from `@` and `$`; sent only when there are some. */
  readonly references?: ReadonlyArray<TurnReference>;
}

export interface SendDraft {
  /** An upload or a dispatch is in flight; the send button is disabled. */
  readonly sending: boolean;
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
  const [sending, setSending] = React.useState(false);
  const sendingRef = React.useRef(false);

  const send = (draft: Draft) => {
    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    onErrorRef.current(null);
    void attachments
      .stage()
      .then((staged) => {
        const message = {
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          threadId,
          text: draft.text,
          attachments: staged.references,
          mentions: [...draft.mentions],
          ...(draft.references?.length ? { references: [...draft.references] } : {}),
        };
        return dispatch(
          draft.mode === "steer"
            ? { ...message, type: "thread.turn.steer" }
            : { ...message, type: "thread.turn.start", queued: draft.mode === "queue" },
        ).then(
          (receipt) => {
            const rejected = receiptError(receipt, "the server rejected the message");
            if (rejected === null) {
              onSentRef.current();
              // Only what went up: an image pasted while it was going up is
              // still in the list and belongs to the next message, not this one.
              attachments.clearStaged(staged.files);
            }
            onErrorRef.current(rejected);
          },
          () => onErrorRef.current(DISPATCH_UNREACHABLE),
        );
      })
      .catch(() => onErrorRef.current("the attachment could not be uploaded"))
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  };

  return { sending, send };
}
