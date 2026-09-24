/**
 * The dock's resize edge from the keyboard, as a pure function.
 *
 * The edge is a focusable `separator` whose value is the dock's width. The
 * dock sits on the right, so Left moves the edge left and widens it, Right
 * narrows it — the same direction a drag goes. Each press is one step, and
 * Shift makes it a bigger one; the result stays inside the bounds the drag
 * obeys (`dockWidthBounds`). Double-clicking the edge resets the width, which
 * needs nothing here.
 */

/** One arrow press, in px. */
export const DOCK_RESIZE_STEP = 16;

/** Shift multiplies the step by this. */
const LARGE_STEP_FACTOR = 4;

/** The width an arrow key leaves the dock at, or `null` for any other key. */
export const dockWidthForKey = (
  key: string,
  shift: boolean,
  width: number,
  bounds: { readonly min: number; readonly max: number },
): number | null => {
  const direction = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : 0;
  if (direction === 0) {
    return null;
  }
  const step = DOCK_RESIZE_STEP * (shift ? LARGE_STEP_FACTOR : 1);
  return Math.max(bounds.min, Math.min(bounds.max, width + direction * step));
};
