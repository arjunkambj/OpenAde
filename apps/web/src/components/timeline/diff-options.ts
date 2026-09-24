/**
 * The `@pierre/diffs` options every `InlineDiff` renders with, apart from the
 * component so the choice is testable without a DOM. Timeline rows never pass
 * a style and stay unified; only the Changes pane offers split.
 */

import type { FileDiffOptions } from "@pierre/diffs/react";

import type { DiffStyle } from "@/state/ui";

export const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

export const inlineDiffOptions = (
  themeType: "light" | "dark",
  diffStyle: DiffStyle = "unified",
): FileDiffOptions<undefined, undefined> => ({
  theme: DIFF_THEMES,
  themeType,
  diffStyle,
  disableFileHeader: true,
  overflow: "scroll",
});
