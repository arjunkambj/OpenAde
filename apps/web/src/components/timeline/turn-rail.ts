/**
 * The turn rail's model: one entry per user message in the projection, the
 * one the reader is in, and where the previous/next message keys go.
 *
 * Every `user_message` row counts, a message steered into a running turn
 * included — it is something the user wrote and may want to find again. A
 * row's position is its index in `TimelineRow[]`, the index `LegendList`
 * scrolls to; it changes when a fold opens, so the rail recomputes from the
 * rows each time.
 *
 * The reader is "in" the last message at or above the first row on screen:
 * the message itself while it is visible, and still that turn while its work
 * and answer fill the viewport. At the end of the list it is the last message
 * on screen, since a short last turn cannot scroll to the top. Rows before the
 * first message (a thread that began without one) are in no turn.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import type { TimelineRow } from "./fold";

/** A preview longer than this is cut, with an ellipsis. */
export const RAIL_PREVIEW_MAX = 80;

export interface RailItem {
  readonly rowId: string;
  /** The row's index in the projection, for `scrollToIndex`. */
  readonly rowIndex: number;
  readonly preview: string;
}

const FENCE = /^\s*(`{3,}|~{3,})/u;

/** Markdown syntax that means nothing in a one-line preview. */
const stripMarkdown = (line: string): string =>
  line
    // Block markers: heading, quote, list bullet or number, task box.
    .replace(/^\s*(?:#{1,6}(?:\s+|$)|>\s?)+/u, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s+/u, "")
    // Images and links keep their text.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    // Emphasis and code marks.
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/gu, "$1$2")
    .replace(/`+([^`]+)`+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * The first line of a message worth showing: fence lines and blank lines are
 * skipped, markdown marks are stripped, and the result is cut to `max`. A
 * message with no text names what it carried instead.
 */
export const railPreview = (
  item: Pick<ItemSnapshot, "text" | "attachments">,
  max: number = RAIL_PREVIEW_MAX,
): string => {
  for (const line of (item.text ?? "").split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      continue;
    }
    const plain = stripMarkdown(line);
    if (plain.length > 0) {
      return cut(plain, max);
    }
  }
  const attached = item.attachments?.length ?? 0;
  if (attached > 0) {
    return attached === 1 ? "1 attachment" : `${attached} attachments`;
  }
  return "Empty message";
};

/** One entry per `user_message` row, in order. */
export const railItems = (rows: ReadonlyArray<TimelineRow>): ReadonlyArray<RailItem> =>
  rows.flatMap((row, rowIndex) =>
    row.kind === "item" && row.item.kind === "user_message"
      ? [{ rowId: row.id, rowIndex, preview: railPreview(row.item) }]
      : [],
  );

/**
 * The index of the row at `offset` in the list's content: the last one whose
 * top is at or above it, or -1 above the first. `positionAt` is the list's
 * row positions, ascending; an unknown one counts as further down.
 */
export const rowAtOffset = (
  count: number,
  positionAt: (index: number) => number | undefined,
  offset: number,
): number => {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const top = positionAt(middle);
    if (top !== undefined && top <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

/**
 * The message the reader is in: the last one at or above the first visible
 * row, undefined above the first one. At the end of the list, where a short
 * last turn can never reach the top, it is the last message on screen
 * instead (`endVisibleIndex`, the last visible row, given only there).
 */
export const activeRailItem = (
  items: ReadonlyArray<RailItem>,
  firstVisibleIndex: number,
  endVisibleIndex?: number,
): RailItem | undefined =>
  items.findLast((item) => item.rowIndex <= (endVisibleIndex ?? firstVisibleIndex));

export type RailDirection = "previous" | "next";

/**
 * The message before or after `activeId`, or undefined at either end. With no
 * active message the reader is above the first one, so "next" is the first.
 */
export const neighbour = (
  items: ReadonlyArray<RailItem>,
  activeId: string | undefined,
  direction: RailDirection,
): RailItem | undefined => {
  const index = activeId === undefined ? -1 : items.findIndex((item) => item.rowId === activeId);
  if (index < 0) {
    return direction === "next" && activeId === undefined ? items[0] : undefined;
  }
  return items[direction === "next" ? index + 1 : index - 1];
};

/**
 * Where the previous/next message keys go from the current scroll. "Previous"
 * first returns to the top of the message the reader is in when that message
 * has scrolled above the viewport, the way a document's "previous heading"
 * does; after that it steps.
 */
export const railTarget = (
  items: ReadonlyArray<RailItem>,
  firstVisibleIndex: number,
  direction: RailDirection,
  endVisibleIndex?: number,
): RailItem | undefined => {
  const active = activeRailItem(items, firstVisibleIndex, endVisibleIndex);
  if (direction === "previous" && active !== undefined && active.rowIndex < firstVisibleIndex) {
    return active;
  }
  return neighbour(items, active?.rowId, direction);
};
