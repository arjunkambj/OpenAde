/**
 * Cuts markdown into top-level blocks that render on their own, so a message
 * that is still streaming re-parses only its growing tail: every block before
 * it keeps its source, and `MarkdownBody` renders each one memoised.
 *
 * A block ends at a blank line, with the exceptions that keep one markdown
 * construct in one block:
 *
 * - nothing inside a fence (``` or ~~~, closed by a run of the same character
 *   at least as long) splits it, blank lines included; a fence still open at
 *   the end of the text makes the last block `open`, with `openFrom` where it
 *   starts. A fence is found at any indent, so one in a nested list item
 *   counts, and inside `>` markers, where the quote ending closes it — the
 *   same fences the parser sees, so a code block still arriving is always
 *   the one marked open;
 * - a line after the blank that is indented continues the block — a list
 *   item's next paragraph, a nested list, indented code;
 * - a list marker after a list, and `>` after a blockquote, continue it too, so
 *   a loose list stays one list and keeps its numbering;
 * - an HTML comment that starts a line runs until it closes.
 *
 * Keys are the block's index (`b0`, `b1`, …): text only ever grows at the end,
 * so a block keeps its key and its source once the next one has begun. A
 * block's source leaves out the blank lines around it.
 *
 * A reference-style link (`[docs][1]`) can sit in one block with its
 * definition (`[1]: https://…`) in another, and parsed alone it would not
 * resolve. The definitions are collected into `definitions` for the caller to
 * append to every block that may use one. Footnotes are not carried across:
 * each block would render the footnote list again, so a footnote whose
 * definition is in another block stays as typed.
 */

export interface MarkdownBlock {
  /** Stable while the text grows: the block's index. */
  readonly key: string;
  /** Where the block's source starts in the text. */
  readonly start: number;
  readonly source: string;
  /** The block ends inside a fence that has not closed yet. */
  readonly open: boolean;
  /**
   * Where that open fence's line starts in `source`, set only when `open`:
   * code from there on is still arriving, so it is not highlighted yet.
   */
  readonly openFrom?: number;
}

export interface MarkdownBlocks {
  readonly blocks: ReadonlyArray<MarkdownBlock>;
  /** Every link reference definition outside a fence, one per line. */
  readonly definitions: string;
}

type BlockKind = "list" | "quote" | "other";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** The `>` markers a line starts with, each with the space after it. */
const QUOTE_MARKERS = /^(?: {0,3}> ?)+/;
const LIST_MARKER = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
const QUOTE = /^ {0,3}>/;
const INDENTED = /^[ \t]/;
const DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
// An HTML comment block starts only at the start of a line; a `<!--` in a
// sentence or a code span is text.
const COMMENT_START = /^ {0,3}<!--/;

const kindOf = (line: string, current: BlockKind): BlockKind => {
  if (LIST_MARKER.test(line)) {
    return "list";
  }
  if (QUOTE.test(line)) {
    return "quote";
  }
  // Any other line — indented, lazy, a heading — belongs to what it follows.
  return current;
};

/** How deep in blockquotes a line sits, and the line inside them. */
const unquote = (line: string): { readonly depth: number; readonly inner: string } => {
  const markers = QUOTE_MARKERS.exec(line)?.[0] ?? "";
  let depth = 0;
  for (const char of markers) {
    if (char === ">") {
      depth += 1;
    }
  }
  return { depth, inner: line.slice(markers.length) };
};

const continues = (kind: BlockKind, line: string): boolean =>
  INDENTED.test(line) ||
  (kind === "list" && LIST_MARKER.test(line)) ||
  (kind === "quote" && QUOTE.test(line));

export const splitMarkdownBlocks = (text: string): MarkdownBlocks => {
  const blocks: MarkdownBlock[] = [];
  const definitions: string[] = [];
  let current: { start: number; end: number; kind: BlockKind } | undefined;
  let fence:
    | {
        readonly char: string;
        readonly length: number;
        /** The blockquote depth it opened at: the quote ending closes it. */
        readonly depth: number;
        /** Where its line starts in the text. */
        readonly start: number;
      }
    | undefined;
  let comment = false;
  let blankSince = false;

  const close = () => {
    if (current !== undefined) {
      const start = current.start;
      blocks.push({
        key: `b${blocks.length}`,
        start,
        source: text.slice(start, current.end),
        ...(fence === undefined ? { open: false } : { open: true, openFrom: fence.start - start }),
      });
      current = undefined;
    }
  };

  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    // A CRLF's carriage return is not part of the line, nor of a block's end.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const blank = line.trim() === "";

    const quoted = unquote(line);
    // A fence opened in a blockquote ends with the quote: a line without its
    // markers, a blank one included, is past it.
    if (fence !== undefined && quoted.depth < fence.depth) {
      fence = undefined;
    }
    if (fence !== undefined || comment) {
      // Inside a fence or a comment nothing splits, and the lines all belong.
      current!.end = lineStart + line.length;
      if (fence !== undefined) {
        const match = FENCE.exec(quoted.inner);
        if (
          match !== null &&
          match[1]![0] === fence.char &&
          match[1]!.length >= fence.length &&
          match[2]!.trim() === ""
        ) {
          fence = undefined;
        }
      } else if (line.includes("-->")) {
        comment = false;
      }
      continue;
    }

    if (blank) {
      blankSince = current !== undefined;
      continue;
    }
    if (current !== undefined && blankSince && !continues(current.kind, line)) {
      close();
    }
    blankSince = false;
    current ??= { start: lineStart, end: lineStart, kind: "other" };
    current.end = lineStart + line.length;
    current.kind = kindOf(line, current.kind);

    const opener = FENCE.exec(quoted.inner);
    // A backtick fence's info string may not itself hold a backtick.
    if (opener !== null && !(opener[1]![0] === "`" && opener[2]!.includes("`"))) {
      fence = {
        char: opener[1]![0]!,
        length: opener[1]!.length,
        depth: quoted.depth,
        start: lineStart,
      };
    } else if (COMMENT_START.test(line) && !/<!--[\s\S]*-->/.test(line)) {
      comment = true;
    } else if (DEFINITION.test(line)) {
      definitions.push(line.trim());
    }
  }
  close();

  return { blocks, definitions: definitions.join("\n") };
};
