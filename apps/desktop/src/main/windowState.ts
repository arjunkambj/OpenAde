/**
 * The persisted window geometry: what is stored, how a stored document is read
 * back, and how a rect is kept on an attached display.
 *
 * `maximized` and `fullScreen` are part of it. Without them a window that was
 * maximized or fullscreen at quit reopened at whatever small rect it last had
 * in its normal state, which is the one thing a user notices immediately.
 * `getNormalBounds()` is what makes that work: it reports the restore rect even
 * while the window is maximized or fullscreen, so one capture covers all three
 * states.
 *
 * Kept free of `electron` so the parsing and the clamping are unit-testable.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

/** The structural slice of `BrowserWindow` a capture needs. */
export interface WindowGeometry {
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getNormalBounds(): Rect;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 820,
  maximized: false,
  fullScreen: false,
};

/** A restored position must keep this much of the window on some display. */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 48;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Anything unreadable reopens at the default geometry rather than failing. */
export const parseWindowState = (raw: string): WindowState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_WINDOW_STATE;
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record["x"] === "number" && Number.isFinite(record["x"]) ? { x: record["x"] } : {}),
    ...(typeof record["y"] === "number" && Number.isFinite(record["y"]) ? { y: record["y"] } : {}),
    width: number(record["width"], DEFAULT_WINDOW_STATE.width),
    height: number(record["height"], DEFAULT_WINDOW_STATE.height),
    maximized: record["maximized"] === true,
    fullScreen: record["fullScreen"] === true,
  };
};

/**
 * Drop the persisted position when a monitor disconnect would leave the window
 * off-screen: the rect must overlap some display's work area by at least the
 * visible minimum, otherwise Electron re-centers it.
 */
export const clampToDisplays = (
  state: WindowState,
  workAreas: ReadonlyArray<Rect>,
): WindowState => {
  const { x, y, width, height } = state;
  if (x === undefined || y === undefined) return state;
  const onScreen = workAreas.some((area) => {
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapX >= MIN_VISIBLE_WIDTH && overlapY >= MIN_VISIBLE_HEIGHT;
  });
  if (onScreen) return state;
  const { maximized, fullScreen } = state;
  return { width, height, maximized, fullScreen };
};

export const captureWindowState = (win: WindowGeometry): WindowState => ({
  ...win.getNormalBounds(),
  maximized: win.isMaximized(),
  fullScreen: win.isFullScreen(),
});
