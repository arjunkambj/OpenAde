/**
 * The `file_change` row's rules, as values: its fallbacks, and which path it
 * asks the workspace about.
 *
 * `fileChange` is optional on `ItemSnapshot`: a connector may report the change
 * as prose and nothing else. The row used to return `null` for that, which took
 * it out of the transcript entirely while the work group above it still counted
 * it in its label and the virtualizer still measured a row for it. Every
 * other row kind falls back to `item.text`, so this is the rule that says what
 * that fallback reads when the text is missing or blank.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

/** The label a `file_change` row without a structured payload shows. */
export const fileChangeFallbackLabel = (text: string | undefined): string =>
  text === undefined || text.trim() === "" ? "file change" : text;

/**
 * The paths the row asks the workspace to confirm, for its chip. None while
 * the change is still running: a Write reports its path as it starts, before
 * the file exists, and "not there" answered then would stand for the file the
 * change goes on to create. The row asks once the change has finished.
 */
export const fileChangeCandidates = (
  item: Pick<ItemSnapshot, "status" | "fileChange">,
): ReadonlyArray<string> =>
  item.fileChange === undefined || item.status === "in_progress" ? [] : [item.fileChange.path];
