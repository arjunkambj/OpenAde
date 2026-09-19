/**
 * The number keys an interaction card answers while it is up, and the rule for
 * when it may claim them at all.
 *
 * Both cards listen on window in capture phase, which is the first node in the
 * propagation path — before every other handler in the app, including React's
 * own root delegate. They have to: `Escape` is bound to `thread.interrupt` in
 * the shipped table, and that binding's listener is on window too, so a card
 * that waited for the bubble would never see Escape at all.
 *
 * What was wrong was not the phase but that the card claimed the keys whatever
 * else was on screen. For an editable target it called `blur()` and
 * `stopPropagation()`, so Escape inside the command palette's input blurred the
 * input and left the palette open — and the next Escape, now on a non-editable
 * target, denied a pending tool call the user had not looked at. And the
 * composer's own Escape handling never ran, because the event never reached the
 * React root: dismissing the `/` menu blurred the textarea and left the menu up.
 *
 * So the decision moved here, and a card claims a key only when nothing closer
 * to the user wants it: no modifier, the event not already handled, focus not
 * in a text field, and no dialog, popover or trigger menu on screen. The
 * blur-and-swallow branch is gone — an editable target and a modal surface now
 * settle Escape themselves. Nothing here ever stops propagation; a claimed key
 * is marked handled with `preventDefault`, which the keybinding listener
 * already honours.
 */

import type { ApprovalDecision } from "@OpenAde/contracts/enums";
import type { PlanResponseAction } from "@OpenAde/contracts/orchestration";

export interface CardKeyContext {
  readonly key: string;
  /** Something nearer the event already handled it. */
  readonly defaultPrevented: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  /** Focus is in a text field, where these keys are ordinary typing. */
  readonly editable: boolean;
  /** A dialog, popover or trigger menu is on screen and owns the keyboard. */
  readonly overlayOpen: boolean;
}

/** Whether a card may answer this key press at all. */
const claimable = (context: CardKeyContext): boolean =>
  !context.defaultPrevented &&
  !context.metaKey &&
  !context.ctrlKey &&
  !context.altKey &&
  !context.editable &&
  !context.overlayOpen;

/** `1` allow once, `2` allow for session, `3` always allow, `d`/Escape deny. */
export const approvalCardKey = (context: CardKeyContext): ApprovalDecision | null => {
  if (!claimable(context)) {
    return null;
  }
  switch (context.key.toLowerCase()) {
    case "1":
      return "allow-once";
    case "2":
      return "allow-session";
    case "3":
      return "allow-always";
    case "d":
    case "escape":
      return "deny";
    default:
      return null;
  }
};

/**
 * `1` accept, `2` accept and run, `3` revise. Escape is deliberately absent: a
 * plan is not a prompt that blocks on an answer, so the card does not answer
 * for the user.
 */
export const planCardKey = (context: CardKeyContext): PlanResponseAction | null => {
  if (!claimable(context)) {
    return null;
  }
  switch (context.key) {
    case "1":
      return "accept";
    case "2":
      return "accept-auto";
    case "3":
      return "revise";
    default:
      return null;
  }
};

/** A target where `1`, `2`, `3` and `d` are text the user is typing. */
const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable);

/**
 * The surfaces that outrank a card: base-ui's dialog, popover, menu and select
 * popups, and the composer's own inline trigger menu. All of them are found by
 * role, which is what every one of them renders.
 */
const OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[role="listbox"]';

export const isOverlayOpen = (root: Pick<Document, "querySelector">): boolean =>
  root.querySelector(OVERLAY_SELECTOR) !== null;

/** The context a card reads off a real key event. */
export const cardKeyContext = (event: KeyboardEvent): CardKeyContext => ({
  key: event.key,
  defaultPrevented: event.defaultPrevented,
  metaKey: event.metaKey,
  ctrlKey: event.ctrlKey,
  altKey: event.altKey,
  editable: isEditableTarget(event.target),
  overlayOpen: isOverlayOpen(document),
});
