/**
 * The failure every RPC shares, in a module of its own so the RPC groups that
 * live outside `rpc.ts` (the git RPCs in `git.ts`) can name it without an
 * import cycle through the group that lists them. `rpc.ts` re-exports it, so
 * `@OpenAde/contracts/rpc` stays the one place a caller imports it from.
 */

import * as Schema from "effect/Schema";

/**
 * The single failure shape every RPC can return. `code` is what the client
 * switches on; `message` is what it shows. Anything the server does not
 * classify surfaces as a defect instead, which is the honest answer for a bug.
 */
export class OpenAdeRpcError extends Schema.TaggedError<OpenAdeRpcError>()("OpenAdeRpcError", {
  code: Schema.Literals(["not-found", "invalid", "unavailable", "conflict", "internal"]),
  message: Schema.String,
}) {}
