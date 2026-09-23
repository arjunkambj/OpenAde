/**
 * "Add selection to chat": the terminal's selected text, appended to this
 * thread's composer draft as a quoted block. It writes the per-thread draft
 * atom and nothing else — the composer renders from that atom, so the text
 * shows up there without the composer knowing where it came from.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import * as React from "react";

import { IconButton } from "@/components/terminal/drawer-parts";
import type { TerminalHandle } from "@/components/terminal/terminal-handle";
import { appendQuotedBlock } from "@/lib/quote-selection";
import { useComposerDraft } from "@/state/ui";
import { Quote } from "@honeyicons/react";

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
  };

  return (
    <IconButton label="Add selection to chat" disabled={!selected} onClick={add}>
      <Quote />
    </IconButton>
  );
}
