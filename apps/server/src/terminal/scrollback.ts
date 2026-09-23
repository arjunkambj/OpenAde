/**
 * The recent output of one terminal, kept so a client that comes back to it
 * sees what the shell printed while it was away.
 *
 * Bounded by `maxChars`. Past the bound the oldest output goes, and the
 * retained text then starts after the first newline in it, so a replay begins
 * at the start of a line rather than in the middle of one — or of an escape
 * sequence, which would paint garbage on the client's screen.
 *
 * `offset` is the total number of chars the terminal has ever produced, not
 * the number retained: it is what lets a client line a snapshot up with the
 * live output it already holds (see `TerminalStreamItem`).
 */
import { TERMINAL_SCROLLBACK_CHARS } from "@OpenAde/contracts/terminal";

/**
 * Small appends are joined onto the last chunk up to this size, so a shell
 * echoing one keystroke at a time does not become a million one-char chunks.
 */
const CHUNK_CHARS = 16 * 1024;

export interface ScrollbackSnapshot {
  readonly data: string;
  readonly offset: number;
}

export interface Scrollback {
  readonly append: (data: string) => void;
  readonly snapshot: () => ScrollbackSnapshot;
  /** Total chars ever appended. */
  readonly offset: () => number;
}

export const makeScrollback = (maxChars: number = TERMINAL_SCROLLBACK_CHARS): Scrollback => {
  let chunks: Array<string> = [];
  let retained = 0;
  let offset = 0;

  const trim = () => {
    // Whole chunks first, then the part of the head chunk still over the bound.
    while (retained > maxChars && chunks.length > 0) {
      const head = chunks[0]!;
      const excess = retained - maxChars;
      if (head.length <= excess) {
        chunks.shift();
        retained -= head.length;
      } else {
        chunks[0] = head.slice(excess);
        retained -= excess;
      }
    }
    cutToLineStart();
  };

  /**
   * Drop everything up to and including the first newline. Output with no
   * newline at all is kept as it is: an empty replay would be worse.
   */
  const cutToLineStart = () => {
    for (let i = 0; i < chunks.length; i++) {
      const at = chunks[i]!.indexOf("\n");
      if (at === -1) continue;
      for (let dropped = 0; dropped < i; dropped++) retained -= chunks[dropped]!.length;
      const rest = chunks[i]!.slice(at + 1);
      retained -= at + 1;
      chunks = rest === "" ? chunks.slice(i + 1) : [rest, ...chunks.slice(i + 1)];
      return;
    }
  };

  return {
    append: (data) => {
      if (data === "") return;
      offset += data.length;
      retained += data.length;
      const last = chunks.length - 1;
      if (last >= 0 && chunks[last]!.length + data.length <= CHUNK_CHARS) {
        chunks[last] += data;
      } else {
        chunks.push(data);
      }
      if (retained > maxChars) trim();
    },
    snapshot: () => ({ data: chunks.join(""), offset }),
    offset: () => offset,
  };
};
