/**
 * The pattern matcher lives in `@OpenAde/shared/permissionPattern` so the
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
} from "@OpenAde/shared/permissionPattern";
export type {
  ParsedPattern,
  PatternFamily,
  PatternSubject,
} from "@OpenAde/shared/permissionPattern";
