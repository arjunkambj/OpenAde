/**
 * When a user message is long enough to clamp. The bubble shows the first
 * lines of a pasted log or a long brief and offers "Show more", rather than
 * letting one message push the rest of the turn off screen.
 *
 * The test is on the source text, not on the rendered height: the list
 * measures rows itself, and a threshold that needs no layout pass keeps the
 * row's first render its final one. A CRLF counts as one line break and one
 * character, the same as the LF the composer would have sent.
 *
 * Only lines with text count. A blank line between paragraphs renders as a
 * paragraph gap, shorter than a line, and blank lines at either end render
 * nothing — counted, six short paragraphs would read as eleven lines and clamp
 * a bubble that fits, fading text that is all on screen behind a "Show more"
 * that reveals nothing. Past ten lines with text the bubble is always taller
 * than the ten-line clamp, whatever the gaps.
 *
 * Fenced code does not wrap: its block scrolls sideways, so a pasted log of a
 * few long lines is wide, not tall. Its characters do not count, and its lines
 * count at what they take on screen — a code line is smaller than a line of
 * text, and the block's header and padding come to about two — each weight a
 * floor, so a message clamped on them is always taller than the clamp.
 */

/** Lines a message may have and still show in full. */
export const USER_MESSAGE_MAX_LINES = 10;

/** Characters a message may have and still show in full. */
export const USER_MESSAGE_MAX_CHARS = 600;

/** A code line against a line of the bubble's text: 16px of 21px, rounded down. */
const CODE_LINE_WEIGHT = 0.75;
/** A code block's header, padding and borders, in lines of the bubble's text. */
const CODE_BLOCK_CHROME = 2;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export const userMessageOverflows = (text: string): boolean => {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  let chars = 0;
  let lines = 0;
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (const line of normalized.split("\n")) {
    if (fence !== undefined) {
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = undefined;
      } else {
        lines += CODE_LINE_WEIGHT;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not itself hold a backtick.
    if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      lines += CODE_BLOCK_CHROME;
      continue;
    }
    chars += line.length + 1;
    if (line.trim() !== "") {
      lines += 1;
    }
  }
  // The last line has no break after it.
  return chars - 1 > USER_MESSAGE_MAX_CHARS || lines > USER_MESSAGE_MAX_LINES;
};
