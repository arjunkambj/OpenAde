/**
 * The terminal's colours and font, read from the app's own tokens at runtime.
 *
 * xterm draws on a canvas and takes its theme as colour strings, so it cannot
 * follow a CSS variable by itself, and our tokens are `oklch(…)`, which xterm
 * cannot be trusted to parse. Each token is therefore resolved to RGBA by
 * painting it on a 1×1 canvas and reading the pixel back — the browser's own
 * colour parser does the conversion — and handed over as `rgb()`/`rgba()`.
 *
 * Only the surface colours come from tokens: background, foreground, cursor
 * and selection. The 16 ANSI colours stay xterm's built-in palette, so the
 * terminal invents no colour values of its own.
 */

import type { ITheme } from "@xterm/xterm";

/** One pixel as `getImageData` returns it: r, g, b and alpha, each 0–255. */
export type Pixel = readonly [number, number, number, number];

/** How strongly the selection tints the text under it. */
const SELECTION_ALPHA = 0.25;

const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/** `rgb(r, g, b)` for an opaque pixel, `rgba(r, g, b, a)` otherwise, `a` to three places. */
export const formatPixel = ([r, g, b, a]: Pixel): string => {
  const alpha = channel(a);
  const rgb = `${channel(r)}, ${channel(g)}, ${channel(b)}`;
  return alpha === 255 ? `rgb(${rgb})` : `rgba(${rgb}, ${Math.round((alpha / 255) * 1000) / 1000})`;
};

/** The same colour with its alpha scaled by `factor`. */
export const withAlpha = ([r, g, b, a]: Pixel, factor: number): Pixel => [r, g, b, a * factor];

/** The surface of the theme, from resolved token pixels. */
export const themeFromPixels = (colors: {
  readonly background: Pixel | null;
  readonly foreground: Pixel | null;
}): ITheme => {
  const theme: { -readonly [K in keyof ITheme]: ITheme[K] } = {};
  if (colors.background !== null) {
    theme.background = formatPixel(colors.background);
  }
  if (colors.foreground !== null) {
    theme.foreground = formatPixel(colors.foreground);
    theme.cursor = formatPixel(colors.foreground);
    theme.selectionBackground = formatPixel(withAlpha(colors.foreground, SELECTION_ALPHA));
  }
  return theme;
};

let paint: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as a pixel, or null when the browser could not parse it. An
 * unparseable value leaves the canvas cleared, so it reads back as fully
 * transparent.
 */
const resolveColor = (value: string): Pixel | null => {
  if (paint === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    paint = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (paint === null || value.trim() === "") {
    return null;
  }
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "rgba(0, 0, 0, 0)";
  paint.fillStyle = value;
  paint.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
  return a === undefined || a === 0 ? null : [r!, g!, b!, a];
};

/**
 * The theme for the tokens as they stand now, and the monospace stack of
 * `host` — an element carrying the `font-mono` utility, so the family is the
 * one the rest of the app's code is set in.
 */
export const readTerminalTheme = (
  host: HTMLElement,
): { readonly theme: ITheme; readonly fontFamily: string } => {
  const tokens = getComputedStyle(document.documentElement);
  return {
    theme: themeFromPixels({
      background: resolveColor(tokens.getPropertyValue("--background")),
      foreground: resolveColor(tokens.getPropertyValue("--foreground")),
    }),
    fontFamily: getComputedStyle(host).fontFamily,
  };
};
