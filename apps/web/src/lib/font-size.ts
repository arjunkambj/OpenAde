/**
 * Applies the Appearance font sizes to the document. globals.css scales every
 * text step in a region by its `--*-font-scale`, the chosen px over the
 * default px.
 *
 * The last sizes are mirrored to localStorage so the first paint already uses
 * them; the settings document only arrives once the server connection is up.
 */

import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "@poseidon/contracts/settings";

const STORAGE_KEY = "poseidon:font-sizes";

export interface FontSizes {
  readonly main: number;
  readonly sidebar: number;
}

const clampFontSize = (size: number): number =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));

/**
 * The sizes after one `font.increase` / `font.decrease` / `font.reset`: main
 * and sidebar move together by `FONT_SIZE_STEP`, each clamped to the range on
 * its own — a sidebar already at the ceiling stays there while main still
 * grows — and reset puts both back on `DEFAULT_FONT_SIZE`.
 */
export const stepFontSizes = (sizes: FontSizes, direction: 1 | -1 | "reset"): FontSizes =>
  direction === "reset"
    ? { main: DEFAULT_FONT_SIZE, sidebar: DEFAULT_FONT_SIZE }
    : {
        main: clampFontSize(sizes.main + direction * FONT_SIZE_STEP),
        sidebar: clampFontSize(sizes.sidebar + direction * FONT_SIZE_STEP),
      };

const setScales = ({ main, sidebar }: FontSizes) => {
  const style = document.documentElement.style;
  style.setProperty("--main-font-scale", String(main / DEFAULT_FONT_SIZE));
  style.setProperty("--sidebar-font-scale", String(sidebar / DEFAULT_FONT_SIZE));
};

export function applyFontSizes(sizes: FontSizes) {
  setScales(sizes);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // Storage can be unavailable; the settings sync applies them on load anyway.
  }
}

export function applyCachedFontSizes() {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      typeof cached === "object" &&
      cached !== null &&
      typeof (cached as FontSizes).main === "number" &&
      typeof (cached as FontSizes).sidebar === "number"
    ) {
      setScales(cached as FontSizes);
    }
  } catch {
    // Nothing usable cached; the defaults apply until settings load.
  }
}
