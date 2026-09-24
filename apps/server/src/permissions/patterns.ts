/**
 * The pattern matcher lives in `@poseidon/shared/permissionPattern` so the
 * renderer can preview "allow always" rules with the exact same semantics the
 * permission engine enforces. This module keeps the server-local import path
 * stable; the implementation is shared, never duplicated.
 */

export {
  matchPattern,
  parsePattern,
  patternMatches,
  requestCommand,
  requestPath,
  requestUrl,
} from "@poseidon/shared/permissionPattern";
export type {
  ParsedPattern,
  PatternFamily,
  PatternSubject,
} from "@poseidon/shared/permissionPattern";
