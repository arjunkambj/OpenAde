/**
 * Applies the Appearance font sizes to the document. globals.css scales every
 * text step in a region by its `--*-font-scale`, the chosen px over the
 * default px.
 *
 * The last sizes are mirrored to localStorage so the first paint already uses
 * them; the settings document only arrives once the server connection is up.
 */

import { DEFAULT_FONT_SIZE } from "@OpenAde/contracts/settings";

const STORAGE_KEY = "openade:font-sizes";

export interface FontSizes {
  readonly main: number;
  readonly sidebar: number;
}

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
