/**
 * Terminal text quoted into a composer draft — the terminal drawer's "Add
 * selection to chat".
 *
 * xterm's selection is the grid as drawn: every selected line is padded with
 * spaces to the edge of the selection, and a drag that starts or ends on an
 * empty row brings blank lines along. Neither is anything the shell printed,
 * so both go before the text becomes a markdown quoted block.
 */

/** Trailing spaces and tabs — the grid's padding, never output. */
const TRAILING_BLANKS = /[ \t]+$/u;

/**
 * The draft with `selection` appended as a `> ` quoted block. A blank line
 * separates it from text already in the draft, and one follows it, so what
 * the user types next starts a new paragraph instead of continuing the quote.
 * A selection with nothing but whitespace leaves the draft as it was.
 */
export const appendQuotedBlock = (draftText: string, selection: string): string => {
  const lines = selection.split(/\r\n|\r|\n/u).map((line) => line.replace(TRAILING_BLANKS, ""));
  const first = lines.findIndex((line) => line !== "");
  if (first === -1) {
    return draftText;
  }
  const last = lines.findLastIndex((line) => line !== "");
  const block = lines
    .slice(first, last + 1)
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const before = draftText.trimEnd();
  return `${before === "" ? "" : `${before}\n\n`}${block}\n\n`;
};
