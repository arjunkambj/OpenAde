/**
 * The workspace file reads' payloads on the wire: a `files.search` hit and a
 * `files.read` window. `rpc.ts` re-exports every one, so importers keep reading
 * them from `@OpenAde/contracts/rpc`.
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
