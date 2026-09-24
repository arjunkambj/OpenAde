/**
 * The line window behind `files.read`. The contract's `offset`/`limit` are a
 * paging interface, so the file is scanned line by line rather than sliced out
 * of one buffered prefix: line 20,000 of a 5MB file is reachable, and
 * `totalLines` counts the whole file instead of the first chunk of it.
 *
 * Two independent bounds keep this safe on a file of any size: at most
 * `SCAN_CAP_BYTES` are ever read, and at most `TEXT_CAP_CHARS` come back.
 * Either one having bitten is reported as `truncated`.
 */
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { FileContent } from "@poseidon/contracts/rpc";

/** The most text one response carries — a window, not a whole file. */
const TEXT_CAP_CHARS = 512 * 1024;
/** The most of a file that is ever walked to count and skip lines. */
const SCAN_CAP_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/**
 * Lines `[offset, offset + limit)` of `target`, with the file's total line
 * count. Line splitting matches `String.split("\n")`: a trailing newline
 * yields a final empty line, and an empty file is one empty line.
 */
export const readFileWindow = async (
  target: string,
  path: string,
  offset: number,
  limit: number | undefined,
): Promise<FileContent> => {
  const handle = await open(target, "r");
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      return { path, text: "", totalLines: 0, truncated: false };
    }

    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const collected: Array<string> = [];
    let pending = "";
    let lineIndex = 0;
    let chars = 0;
    let scanned = 0;
    /** A bound bit, as opposed to `limit` simply having been satisfied. */
    let capped = false;

    const emit = (line: string): void => {
      if (capped || lineIndex < offset) return;
      if (limit !== undefined && collected.length >= limit) return;
      const room = TEXT_CAP_CHARS - chars;
      if (line.length > room) {
        // A single line longer than the whole window still answers something.
        if (room > 0) collected.push(line.slice(0, room));
        capped = true;
        return;
      }
      collected.push(line);
      // The join puts the separator back, so it costs a character too.
      chars += line.length + 1;
    };

    for (;;) {
      if (scanned >= SCAN_CAP_BYTES) {
        capped = true;
        break;
      }
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(CHUNK_BYTES, SCAN_CAP_BYTES - scanned),
        scanned,
      );
      if (bytesRead === 0) break;
      scanned += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) break;
        emit(pending + chunk.slice(start, newline));
        pending = "";
        lineIndex += 1;
        start = newline + 1;
      }
      pending += chunk.slice(start);
    }
    pending += decoder.end();
    // Whatever follows the last newline is the last line, empty or not.
    emit(pending);
    const totalLines = lineIndex + 1;

    return {
      path,
      text: collected.join("\n"),
      totalLines,
      truncated: capped || offset + collected.length < totalLines,
    };
  } finally {
    await handle.close();
  }
};
