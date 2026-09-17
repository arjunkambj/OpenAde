/**
 * The arithmetic and the two judgement calls behind the files tab's preview,
 * kept apart from the component so both are testable.
 *
 * `files.read` is a paging interface: it answers lines `[offset, offset+limit)`
 * plus the file's real `totalLines`, and reports `truncated` when its own byte
 * or character cap bit. So the preview is a page over the whole file rather
 * than one best-effort slice — page 41 of a 20,000-line file is a request, not
 * a scroll.
 *
 * The judgement calls: what counts as binary (the server decodes every file as
 * UTF-8, so a PNG comes back as mojibake rather than as an error), and where a
 * page ends when the server returned fewer lines than were asked for.
 */

import type { FileContent } from "@OpenAde/contracts/rpc";

/** Lines per page. Big enough to read, small enough to render as plain DOM. */
export const PAGE_LINES = 500;

/** The `files.read` window for a zero-based page number. */
export const windowFor = (page: number): { readonly offset: number; readonly limit: number } => ({
  offset: Math.max(0, Math.trunc(page)) * PAGE_LINES,
  limit: PAGE_LINES,
});

export interface PagePosition {
  /** 1-based, inclusive. Zero when the page holds no lines at all. */
  readonly firstLine: number;
  readonly lastLine: number;
  readonly totalLines: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  /** The footer sentence — "Lines 501–1,000 of 12,043". */
  readonly label: string;
}

const count = (value: number): string => value.toLocaleString("en-US");

/** Where this page sits in the file, given what the server actually returned. */
export const pagePosition = (page: number, content: FileContent): PagePosition => {
  const { offset } = windowFor(page);
  const lines = lineCount(content.text);
  const total = Math.max(content.totalLines, offset + lines);
  const firstLine = lines === 0 ? 0 : offset + 1;
  const lastLine = offset + lines;
  return {
    firstLine,
    lastLine,
    totalLines: total,
    hasPrevious: offset > 0,
    // Trust the returned line count over `totalLines`: a page that came back
    // short is the last one even if the file grew between two reads.
    hasNext: lines > 0 && lastLine < total,
    label:
      lines === 0
        ? total === 0
          ? "Empty file"
          : `No lines past ${count(offset)} of ${count(total)}`
        : `Lines ${count(firstLine)}–${count(lastLine)} of ${count(total)}`,
  };
};

/**
 * Lines in a `files.read` response. The server splits on "\n" exactly as
 * `String.split` does, so an empty body is one empty line — except that an
 * empty *file* answers `totalLines: 0`, and a window past the end answers an
 * empty body. Both of those are "no lines", not "one blank line".
 */
export const lineCount = (text: string): number => (text === "" ? 0 : text.split("\n").length);

/** One numbered row of the preview. `number` is 1-based within the whole file. */
export interface PreviewLine {
  readonly number: number;
  readonly text: string;
}

export const previewLines = (page: number, content: FileContent): ReadonlyArray<PreviewLine> => {
  if (content.text === "") {
    return [];
  }
  const { offset } = windowFor(page);
  return content.text.split("\n").map((text, index) => ({ number: offset + index + 1, text }));
};

/** How much of the text is sampled before deciding it is not text. */
const BINARY_SAMPLE = 4_096;

/**
 * The two characters this test is about, built rather than written: the
 * formatter rewrites a `\u0000` escape into the byte itself, and an invisible
 * control character in a source file is unreadable in every diff after that.
 */
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xff_fd);

/**
 * Whether this is a file no preview should render.
 *
 * The server has no content-type notion: it decodes every byte range as UTF-8
 * and hands back whatever that produced. A NUL byte survives that decode
 * intact and never appears in source, and bytes that are not valid UTF-8 come
 * back as U+FFFD - a few of those are a stray encoding, a page full of them is
 * an image. Either way the answer is "binary", not a wall of mojibake.
 */
export const looksBinary = (text: string): boolean => {
  const sample = text.slice(0, BINARY_SAMPLE);
  if (sample.includes(NUL)) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }
  let replacements = 0;
  for (const character of sample) {
    if (character === REPLACEMENT) {
      replacements += 1;
    }
  }
  return replacements / sample.length > 0.1;
};

/**
 * The directory prefix and the basename of a search hit, so the list can show
 * the name and mute the path it sits under.
 */
export const splitPath = (path: string): { readonly directory: string; readonly name: string } => {
  const cut = path.lastIndexOf("/");
  return cut < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};
