/**
 * Where each pane webview sits, as pure functions of the pane's slot and the
 * viewport.
 *
 * The one rule: a webview is never offscreen, 0×0, `visibility: hidden` or
 * `display: none`. Chromium stops delivering input to a guest laid out that
 * way and `Page.captureScreenshot` never answers, so the agent could neither
 * click nor see a tab the person is not looking at. A hidden tab therefore
 * keeps a real size inside the viewport — the pane's last size, so a
 * screenshot looks like what the pane would show — and is hidden by the host
 * with opacity and a place beneath the app instead.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The size a hidden tab takes when the pane was never on screen this session. */
export const DEFAULT_HIDDEN_SIZE: Size = { width: 1024, height: 768 };

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** A slot's rect, or `null` when it has no area to show a page in. */
export const visibleRect = (slot: Rect | null): Rect | null =>
  slot === null || slot.width < 1 || slot.height < 1
    ? null
    : {
        x: Math.round(slot.x),
        y: Math.round(slot.y),
        width: Math.round(slot.width),
        height: Math.round(slot.height),
      };

/**
 * Where a hidden tab is laid out: at the pane's last rect, or the default
 * size at the origin, shrunk and moved as needed to sit wholly inside the
 * viewport, and never smaller than 1×1.
 */
export const hiddenRect = (lastPane: Rect | null, viewport: Size): Rect => {
  const base = lastPane ?? { x: 0, y: 0, ...DEFAULT_HIDDEN_SIZE };
  const maxWidth = Math.max(1, Math.floor(viewport.width));
  const maxHeight = Math.max(1, Math.floor(viewport.height));
  const width = clamp(Math.round(base.width), 1, maxWidth);
  const height = clamp(Math.round(base.height), 1, maxHeight);
  return {
    x: clamp(Math.round(base.x), 0, maxWidth - width),
    y: clamp(Math.round(base.y), 0, maxHeight - height),
    width,
    height,
  };
};

export interface Placement {
  readonly rect: Rect;
  readonly visible: boolean;
}

/**
 * A tab is visible when it is its thread's selected tab and that thread's
 * pane is on screen with some area; every other tab takes the hidden rect.
 */
export const placeTab = (
  tab: { readonly threadId: string; readonly selected: boolean },
  slot: { readonly threadId: string; readonly rect: Rect | null } | null,
  lastPane: Rect | null,
  viewport: Size,
): Placement => {
  const shown = slot !== null && slot.threadId === tab.threadId ? visibleRect(slot.rect) : null;
  return tab.selected && shown !== null
    ? { rect: shown, visible: true }
    : { rect: hiddenRect(lastPane, viewport), visible: false };
};
