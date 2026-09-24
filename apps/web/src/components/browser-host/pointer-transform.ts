/**
 * Where the agent's pointer lands on screen.
 *
 * The shell tells the window where the agent moved or pressed in a tab
 * (`apps/desktop/src/main/browser/agentPointer.ts`), in CSS pixels of the
 * page's viewport — what the agent sent over CDP. The page is drawn at the
 * tab's zoom inside the webview's box, so a point is scaled by the zoom
 * factor (1.2 to the power of the level) and offset by the box. A point
 * outside the box is not drawn.
 */

import type { Rect } from "./host-geometry";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const pointerOnPane = (point: Point, box: Rect, zoomLevel: number): Point | null => {
  const factor = 1.2 ** zoomLevel;
  const x = point.x * factor;
  const y = point.y * factor;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;
  return { x: box.x + x, y: box.y + y };
};
