/**
 * The composer's own keys, shared by the thread composer and the start
 * screen: focus it, attach files, clear the draft, and `composer.queue`.
 *
 * `composer.queue` (Mod+Enter by default) is a row in the table like any
 * other: the textarea leaves chorded Enter to the listener (`composer-keys`),
 * so whatever the user binds the command to is what queues. With the focus in
 * this composer's textarea it submits; anywhere else it puts the focus back
 * here, which is the useful half of "send this" when there is nothing typed
 * in front of the user.
 *
 * Attach opens the same hidden file input the toolbar's button does. When the
 * connector cannot take attachments the key says so with the button's
 * sentence and opens nothing.
 *
 * A thread's composer also takes the focus when the create flow asks for it
 * (`@/lib/composer-focus`), so starting a thread — `Mod+Shift+N`, the palette,
 * the sidebar — leaves the user typing into it.
 */

import * as React from "react";

import type { Attachments } from "@/components/composer/use-attachments";
import { onComposerFocusRequest, takeComposerFocus } from "@/lib/composer-focus";
import { useKeybindingCommand } from "@/lib/shortcuts";

export function useComposerCommands({
  threadId,
  textareaRef,
  fileInputRef,
  attachments,
  clearDraft,
  submit,
}: {
  /** The thread this composer writes to; the start screen has none yet. */
  readonly threadId?: string;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly attachments: Attachments;
  readonly clearDraft: () => void;
  /** What `composer.queue` does with the focus in the textarea. */
  readonly submit: () => void;
}): void {
  const focus = () => textareaRef.current?.focus();
  React.useEffect(() => {
    if (threadId === undefined) {
      return;
    }
    const claim = () => {
      if (takeComposerFocus(threadId)) {
        textareaRef.current?.focus();
      }
    };
    claim();
    return onComposerFocusRequest(claim);
  }, [threadId, textareaRef]);
  useKeybindingCommand("composer.focus", focus);
  useKeybindingCommand("composer.attach", () => {
    if (!attachments.refuse()) {
      fileInputRef.current?.click();
    }
  });
  useKeybindingCommand("composer.clearDraft", clearDraft);
  useKeybindingCommand("composer.queue", () => {
    if (textareaRef.current !== null && document.activeElement === textareaRef.current) {
      submit();
    } else {
      focus();
    }
  });
}
