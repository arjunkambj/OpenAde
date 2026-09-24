/**
 * Who owns the timeline's scroll position. A pure reducer, driven by
 * `use-send-anchor.ts`, whose derived props go straight to `LegendList`.
 *
 * - `follow` is the list's default: it opens at its end and follows new rows
 *   while it sits there (`maintainScrollAtEnd`).
 * - `anchored` starts when the user sends: the new message is placed near the
 *   top of the viewport and held there while the reply streams in below it.
 * - `free` starts when the reader scrolls while anchored, or opens a turn
 *   fold (`rowsOpened`) while following or anchored: nothing moves the
 *   list until it is back at its end or the reader jumps to the latest row —
 *   or until they send a message themselves (`sentHere`).
 *
 * The last sent message keeps an end reserve (`reserveRowId`, LegendList's
 * `anchoredEndSpace`) in every mode: the trailing space that lets it reach the
 * top while the reply is still shorter than a screen. The reserve shrinks on
 * its own as the reply grows, so it never has to be dropped — dropping it
 * under a reader who scrolled would clamp the scroll and jump the page.
 *
 * Only a user message that appears after the list mounted, while a turn is
 * requested or running, counts as a send. That covers a queued message whose
 * turn starts later; the history a thread opens with never anchors. From
 * `free`, or from `follow` with the list scrolled more than half a screen
 * from its end (`awayFromEnd`), it takes a send this window just made
 * (`state/local-sends.ts`): a queued message drained minutes later, or one
 * sent from another window, would otherwise pull a reader who scrolled away
 * back down without their asking. Following says only that the list follows
 * its end while it sits there, not that it does sit there: a reader who opened
 * the thread and scrolled up into history is still following.
 */

import type { TimelineRow } from "./fold";

export type SendAnchorMode = "follow" | "anchored" | "free";

export interface SendAnchorState {
  readonly mode: SendAnchorMode;
  /** The last message sent while this list was mounted; null before the first. */
  readonly sentRowId: string | null;
  /** Bumped whenever the anchored row has to be put back at the top. */
  readonly placement: number;
}

export type SendAnchorEvent =
  | {
      readonly type: "rowsChanged";
      /** A user message row that was not there before, when it is the latest one. */
      readonly newUserMessageId?: string | undefined;
      readonly turnActive: boolean;
      /** This window sent that message just now, rather than the queue or another window. */
      readonly sentHere?: boolean | undefined;
      /** The list sits more than half a screen from its end: the reader scrolled away. */
      readonly awayFromEnd?: boolean | undefined;
    }
  | { readonly type: "userScrollIntent" }
  /** The reader opened a turn fold: its rows arrive right under the toggle. */
  | { readonly type: "rowsOpened" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "jumpToLatest" }
  | { readonly type: "turnSettled" };

export const INITIAL_SEND_ANCHOR: SendAnchorState = {
  mode: "follow",
  sentRowId: null,
  placement: 0,
};

export const sendAnchorReducer = (
  state: SendAnchorState,
  event: SendAnchorEvent,
): SendAnchorState => {
  switch (event.type) {
    case "rowsChanged":
      if (event.newUserMessageId === undefined || !event.turnActive) {
        return state;
      }
      // A reader who scrolled away keeps their place, unless they sent it.
      // Anchored, the reader has not scrolled since their last send.
      if (
        event.sentHere !== true &&
        (state.mode === "free" || (state.mode === "follow" && event.awayFromEnd === true))
      ) {
        return state;
      }
      return {
        mode: "anchored",
        sentRowId: event.newUserMessageId,
        placement: state.placement + 1,
      };
    case "userScrollIntent":
      return state.mode === "anchored" ? { ...state, mode: "free" } : state;
    case "rowsOpened":
      // Following, the list would scroll to its new end and carry the toggle
      // and the start of what it revealed up out of view; anchored, the hold
      // would move it. Either way the rows should open in place, under the
      // reader's eyes, so the scroll is theirs from here.
      return state.mode === "free" ? state : { ...state, mode: "free" };
    case "reachedEnd":
      // Anchored, the list sits at its end by design: the reserve fills the
      // screen under the message. Only a reader's own scroll back down resumes.
      return state.mode === "free" ? { ...state, mode: "follow" } : state;
    case "jumpToLatest":
      return state.mode === "follow" ? state : { ...state, mode: "follow" };
    case "turnSettled":
      // The fold closes the turn's work under the message: hold it again so a
      // reserve that catches up a frame late cannot move it, and never jump.
      return state.mode === "anchored" ? { ...state, placement: state.placement + 1 } : state;
  }
};

export interface SendAnchorProps {
  readonly maintainScrollAtEnd: boolean;
  /** The row held at the top of the viewport; null unless anchored. */
  readonly anchorRowId: string | null;
  /** The row whose end reserve lets it reach the top. */
  readonly reserveRowId: string | null;
}

export const sendAnchorProps = (state: SendAnchorState): SendAnchorProps => ({
  maintainScrollAtEnd: state.mode === "follow",
  anchorRowId: state.mode === "anchored" ? state.sentRowId : null,
  reserveRowId: state.sentRowId,
});

/** Whether `next` holds an open fold that `previous` did not: the reader opened one. */
export const foldsOpened = (previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean => {
  for (const rowId of next) {
    if (!previous.has(rowId)) {
      return true;
    }
  }
  return false;
};

/** The row ids a projection holds, for the next `sentUserMessageId`. */
export const rowIdSet = (rows: ReadonlyArray<TimelineRow>): ReadonlySet<string> =>
  new Set(rows.map((row) => row.id));

/**
 * The latest user message row, when it was not among `previousIds`. Null on
 * the first projection (`previousIds` null), so opening a thread never anchors,
 * and null when the new message is not the latest one.
 */
export const sentUserMessageId = (
  previousIds: ReadonlySet<string> | null,
  rows: ReadonlyArray<TimelineRow>,
): string | null => {
  if (previousIds === null) {
    return null;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "item" && row.item.kind === "user_message") {
      return previousIds.has(row.id) ? null : row.id;
    }
  }
  return null;
};

/** Keys that scroll a focused scroller, as the browser reads them. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "ArrowUp",
  "ArrowDown",
]);

export const isScrollKey = (key: string): boolean => SCROLL_KEYS.has(key);
