/**
 * The `@pierre/diffs` options every `InlineDiff` and markdown code block
 * renders with, apart from the components so the choice is testable without a
 * DOM. Timeline rows never pass a diff style and stay unified; only the
 * Changes pane offers split.
 */

import type { FileDiffOptions, FileOptions } from "@pierre/diffs/react";

import type { DiffStyle } from "@/state/ui";

import { HIGHLIGHT_MAX_CHARS } from "./code-fence";

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

/**
 * A markdown code block's options: the diff themes, no header or gutter (the
 * block draws its own header), wrapping when the reader asked for it, and a
 * tokenize cap matching the one past which the block renders plain anyway.
 */
export const codeFileOptions = (
  themeType: "light" | "dark",
  wrap: boolean,
): FileOptions<undefined, undefined> => ({
  theme: DIFF_THEMES,
  themeType,
  disableFileHeader: true,
  disableLineNumbers: true,
  overflow: wrap ? "wrap" : "scroll",
  tokenizeMaxLength: HIGHLIGHT_MAX_CHARS,
});
