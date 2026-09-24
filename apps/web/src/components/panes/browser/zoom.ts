/**
 * The pane's zoom steps. A webview zooms by level — the factor is 1.2 to the
 * power of the level — but a person thinks in percent, so zoom moves through
 * the same percentages a desktop browser offers and converts at the edge.
 */

/** Chromium's own zoom presets, as factors. */
const ZOOM_FACTORS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

const factorOf = (level: number): number => 1.2 ** level;

const levelOf = (factor: number): number => Math.log(factor) / Math.log(1.2);

/** The level a webview takes for one step in or out from `level`. */
export const stepZoom = (level: number, direction: "in" | "out"): number => {
  const factor = factorOf(level);
  // A hair of slack, so a level read back from the webview lands on its preset.
  const next =
    direction === "in"
      ? ZOOM_FACTORS.find((preset) => preset > factor + 0.005)
      : ZOOM_FACTORS.findLast((preset) => preset < factor - 0.005);
  return next === undefined ? level : levelOf(next);
};

/** The level, in percent: `100` at level 0. */
export const zoomPercent = (level: number): number => Math.round(factorOf(level) * 100);

/** Whether `stepZoom` can move further that way. */
export const canZoom = (level: number, direction: "in" | "out"): boolean =>
  stepZoom(level, direction) !== level;
