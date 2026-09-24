/**
 * The renderer's side of `./thread-selection`: the picked rows live in one
 * atom, renderer-only and never persisted — a selection is a gesture in
 * progress, not a preference. Rows that leave the list drop out of it on read.
 */

import { useAtom } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import {
  EMPTY_SELECTION,
  liveSelection,
  selectThreads,
  type SelectGesture,
  type ThreadSelection,
} from "@/components/sidebar/thread-selection";

const threadSelectionAtom = Atom.keepAlive(Atom.make<ThreadSelection>(EMPTY_SELECTION));

export interface ThreadSelectionControls {
  readonly selection: ThreadSelection;
  readonly select: (threadId: string, gesture: SelectGesture) => void;
  readonly clear: () => void;
}

export const useThreadSelection = (
  order: ReadonlyArray<{ readonly threadId: string }>,
  openThreadId: string | null,
): ThreadSelectionControls => {
  const [stored, setStored] = useAtom(threadSelectionAtom);
  const selection = React.useMemo(() => liveSelection(order, stored), [order, stored]);

  const select = React.useCallback(
    (threadId: string, gesture: SelectGesture) =>
      setStored((current) => selectThreads(order, current, openThreadId, threadId, gesture)),
    [setStored, order, openThreadId],
  );
  const clear = React.useCallback(() => setStored(EMPTY_SELECTION), [setStored]);

  // Escape lets go of the selection, as it does in any list. The key is not
  // swallowed: whatever else answers it still does.
  const selecting = selection.ids.size > 0;
  React.useEffect(() => {
    if (!selecting) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clear();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, clear]);

  return { selection, select, clear };
};
