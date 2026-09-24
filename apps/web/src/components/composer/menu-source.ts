/**
 * One list behind a trigger menu — the project's files for `#`, the instance's
 * plugins or skills for `@` and `$` — read from its atom as what the menu's
 * empty row has to say.
 *
 * `AsyncResult.isSuccess` alone cannot say it. These atoms start from an
 * `initialValue` of `[]`, so while the RPC is in flight they read as a
 * *successful empty list* (`waiting` set), and a menu that trusted that would
 * tell the user the harness has no skills while it is still being asked. A
 * failure is not an empty list either: it says the list could not be read.
 */

import * as Cause from "effect/Cause";
import { isTagged } from "effect/Predicate";
import { AsyncResult } from "effect/unstable/reactivity";

export type MenuSourceStatus = "loading" | "failed" | "ready";

export interface MenuSource<A> {
  readonly status: MenuSourceStatus;
  /** What the list holds so far; `[]` until it first answers, and after a failure. */
  readonly entries: ReadonlyArray<A>;
}

/**
 * An `unavailable` answer is the instance saying it has no such extension (or
 * is not open), which for a menu is the same as having none.
 */
const isUnavailable = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause);
  return isTagged(error, "PoseidonRpcError") && "code" in error && error.code === "unavailable";
};

export const menuSource = <A>(
  result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>,
): MenuSource<A> => {
  if (AsyncResult.isSuccess(result)) {
    return { status: result.waiting ? "loading" : "ready", entries: result.value };
  }
  if (AsyncResult.isFailure(result)) {
    if (result.waiting) {
      return { status: "loading", entries: [] };
    }
    return { status: isUnavailable(result.cause) ? "ready" : "failed", entries: [] };
  }
  return { status: "loading", entries: [] };
};

/**
 * What a menu that asks again on every keystroke shows while its answer
 * catches up with the draft.
 *
 * The `#` menu keys `files.search` by the deferred query, and each new query is
 * a new atom that starts as an in-flight empty list. Read as-is, the menu would
 * open on the answer for the query it had while closed (`""`, answered empty:
 * "No files match") and then fall to a lone "Searching…" row on every
 * keystroke. So until the search has caught up (`settled`) and while it has
 * nothing new to show, the menu keeps the rows it last had (`held`) and says it
 * is loading; with nothing held yet, that is "Searching…".
 */
export const heldMenuSource = <A>(
  current: MenuSource<A>,
  settled: boolean,
  held: ReadonlyArray<A>,
): MenuSource<A> => {
  if (!settled || (current.status === "loading" && current.entries.length === 0)) {
    return { status: "loading", entries: held };
  }
  return current;
};

/** The `#` menu's row when it lists no files. */
export const fileMenuEmptyLabel = (status: MenuSourceStatus): string =>
  status === "loading"
    ? "Searching…"
    : status === "failed"
      ? "Could not search files"
      : "No files match";
