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
 */

/** Lines a message may have and still show in full. */
export const USER_MESSAGE_MAX_LINES = 10;

/** Characters a message may have and still show in full. */
export const USER_MESSAGE_MAX_CHARS = 600;

export const userMessageOverflows = (text: string): boolean => {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > USER_MESSAGE_MAX_CHARS) {
    return true;
  }
  let lines = 0;
  for (const line of normalized.split("\n")) {
    if (line.trim() !== "") {
      lines += 1;
    }
  }
  return lines > USER_MESSAGE_MAX_LINES;
};
