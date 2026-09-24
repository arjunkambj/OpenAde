/**
 * "Add selection to chat": the terminal's selected text, appended to this
 * thread's composer draft as a quoted block. It writes the per-thread draft
 * atom and nothing else — the composer renders from that atom, so the text
 * shows up there without the composer knowing where it came from.
 *
 * Focus then moves to the composer, caret after the quote, since what comes
 * next is the question about it. Clearing the selection disables this button,
 * and a disabled button drops focus to the page, where the keys the user
 * types would reach whatever listens there — an approval card's 1/2/3, say.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import * as React from "react";

import { IconButton } from "@/components/terminal/drawer-parts";
import type { TerminalHandle } from "@/components/terminal/terminal-handle";
import { appendQuotedBlock } from "@/lib/quote-selection";
import { useComposerDraft } from "@/state/ui";
import { Quote } from "@honeyicons/react";

/**
 * The thread's composer input, found by the `data-context="composer"` mark
 * the keybinding listener reads too; null when it is not on screen or cannot
 * take text.
 */
const composerInput = (): HTMLTextAreaElement | null => {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[data-context="composer"]');
  return input === null || input.disabled ? null : input;
};

export function AddSelectionButton({
  threadId,
  handle,
}: {
  threadId: ThreadId;
  handle: TerminalHandle | null;
}) {
  const { setText } = useComposerDraft(threadId);
  const [selected, setSelected] = React.useState(false);

  React.useEffect(() => {
    if (handle === null) {
      setSelected(false);
      return;
    }
    return handle.watchSelection(setSelected);
  }, [handle]);

  const add = () => {
    if (handle === null) {
      return;
    }
    // Read now: the draft updater may run later, after the selection moved.
    const selection = handle.selection();
    setText((current) => appendQuotedBlock(current, selection));
    handle.clearSelection();
    const input = composerInput();
    if (input === null) {
      handle.focus();
      return;
    }
    input.focus();
    // After the render that puts the quote in the textarea.
    requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
  };

  return (
    <IconButton label="Add selection to chat" disabled={!selected} onClick={add}>
      <Quote variant="bold" />
    </IconButton>
  );
}
