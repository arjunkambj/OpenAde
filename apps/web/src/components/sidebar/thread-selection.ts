/**
 * Picking several thread rows at once, as data.
 *
 * A thread row is a link, and a modified click on a link is the browser's to
 * answer: Shift opens a new window and Cmd/Ctrl a new tab, which the desktop
 * shell hands to the OS browser — the app itself in a browser tab, not what
 * anyone meant. The row answers those clicks itself instead, the way a file
 * list does:
 *
 * - Cmd/Ctrl-click adds a row to the selection or takes it out, and becomes
 *   the anchor;
 * - Shift-click selects every row from the anchor to the clicked one, and
 *   keeps the anchor, so a second Shift-click redraws the range from the same
 *   end;
 * - with nothing selected yet, the open thread counts as selected and as the
 *   anchor, so Cmd-clicking a second row selects both, and Shift-clicking one
 *   selects everything in between.
 *
 * Rows are walked in `./thread-order`'s order, the order they are drawn in.
 */

export interface ThreadSelection {
  readonly ids: ReadonlySet<string>;
  /** Where a Shift-click range starts; the last row Cmd/Ctrl-clicked. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: ThreadSelection = { ids: new Set(), anchor: null };

/** Cmd/Ctrl-click toggles one row; Shift-click selects a range. */
export type SelectGesture = "toggle" | "range";

/** The gesture a click carries, or `null` for a plain click that just opens the thread. */
export const selectGestureOf = (event: {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): SelectGesture | null =>
  event.shiftKey ? "range" : event.metaKey || event.ctrlKey ? "toggle" : null;

type Row = { readonly threadId: string };

const listed = (order: ReadonlyArray<Row>, threadId: string | null): threadId is string =>
  threadId !== null && order.some((row) => row.threadId === threadId);

/** The selection after `gesture` on the row `clicked`. */
export const selectThreads = (
  order: ReadonlyArray<Row>,
  current: ThreadSelection,
  openThreadId: string | null,
  clicked: string,
  gesture: SelectGesture,
): ThreadSelection => {
  const live = liveSelection(order, current);
  const fresh = live.ids.size === 0;

  if (gesture === "toggle") {
    const ids = new Set(fresh && listed(order, openThreadId) ? [openThreadId] : live.ids);
    if (ids.has(clicked)) {
      ids.delete(clicked);
    } else {
      ids.add(clicked);
    }
    return { ids, anchor: clicked };
  }

  const anchor = listed(order, live.anchor)
    ? live.anchor
    : listed(order, openThreadId)
      ? openThreadId
      : clicked;
  const from = order.findIndex((row) => row.threadId === anchor);
  const to = order.findIndex((row) => row.threadId === clicked);
  if (from === -1 || to === -1) {
    return { ids: new Set([clicked]), anchor: clicked };
  }
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { ids: new Set(order.slice(start, end + 1).map((row) => row.threadId)), anchor };
};

/**
 * The selection without the rows that left the list — deleted, archived, or
 * folded away under their project — so a bulk action never reaches a thread
 * that is no longer on screen.
 */
export const liveSelection = (
  order: ReadonlyArray<Row>,
  selection: ThreadSelection,
): ThreadSelection => {
  if (selection.ids.size === 0) {
    return selection;
  }
  const ids = new Set(
    order.filter((row) => selection.ids.has(row.threadId)).map((r) => r.threadId),
  );
  if (ids.size === selection.ids.size) {
    return selection;
  }
  return { ids, anchor: listed(order, selection.anchor) ? selection.anchor : null };
};

/** The selected rows, top to bottom. */
export const selectedRows = <T extends Row>(
  order: ReadonlyArray<T>,
  selection: ThreadSelection,
): ReadonlyArray<T> => order.filter((row) => selection.ids.has(row.threadId));
