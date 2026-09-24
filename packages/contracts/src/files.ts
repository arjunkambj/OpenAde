/**
 * The workspace file reads' payloads on the wire: a `files.search` hit and a
 * `files.read` window. `rpc.ts` re-exports every one, so importers keep reading
 * them from `@poseidon/contracts/rpc`.
 */

import * as Schema from "effect/Schema";

import { NonEmptyString, NonNegativeInt } from "./base";

/** One hit from the composer's `#` file search. */
export const FileSearchResult = Schema.Struct({
  path: NonEmptyString,
  name: NonEmptyString,
  isDirectory: Schema.Boolean,
});
export type FileSearchResult = typeof FileSearchResult.Type;

/**
 * A file the client asked to read. `truncated` says the server stopped early —
 * the files pane shows a notice rather than pretending it has the whole file.
 */
export const FileContent = Schema.Struct({
  path: NonEmptyString,
  text: Schema.String,
  totalLines: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type FileContent = typeof FileContent.Type;

/** The most paths one `files.stat` call may ask about. */
export const FILES_STAT_MAX_PATHS = 100;

/**
 * One path `files.stat` confirmed: it exists, and it resolves — symlinks
 * followed — to somewhere strictly inside the workspace root. `path` is the
 * string as it was asked, so a caller maps answers back to its own
 * candidates; `relativePath` is the path under the root with `/` separators
 * (the link's own name when it went through an in-root symlink, which is the
 * name `files.read` accepts back); `absolutePath` joins that onto the root.
 */
export const FileStat = Schema.Struct({
  path: NonEmptyString,
  relativePath: NonEmptyString,
  absolutePath: NonEmptyString,
  isDirectory: Schema.Boolean,
});
export type FileStat = typeof FileStat.Type;
