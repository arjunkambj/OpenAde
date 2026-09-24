/**
 * The `file_change` row's fallbacks, as values.
 *
 * `fileChange` is optional on `ItemSnapshot`: a connector may report the change
 * as prose and nothing else. The row used to return `null` for that, which took
 * it out of the transcript entirely while the work group above it still counted
 * it in its label and the virtualizer still measured a row for it. Every
 * other row kind falls back to `item.text`, so this is the rule that says what
 * that fallback reads when the text is missing or blank.
 */

/** The label a `file_change` row without a structured payload shows. */
export const fileChangeFallbackLabel = (text: string | undefined): string =>
  text === undefined || text.trim() === "" ? "file change" : text;
