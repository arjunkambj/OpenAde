/**
 * Whether `/` should hand the user to the welcome flow instead of the
 * project picker.
 *
 * The guard used to read `isSuccess(projects) && !projects.waiting &&
 * projects.value.length === 0`, and `!waiting` is never true here. An atom over
 * a stream sets `AsyncResult.success(value, { waiting: true })` on every
 * emission and only drops `waiting` when the stream *ends*; `projectsAtom` is
 * driven by `SubscriptionRef.changes` and never ends. So the redirect was dead
 * code and a fresh install landed on "Start a thread" with no rows and no way
 * to make one.
 *
 * The `waiting` term was there for a real reason, though: `projectsAtom` was
 * seeded with `[]`, which reads as a successful empty list from the first
 * frame, so without it every cold load bounced to /welcome before
 * `projects.list` had answered — projects or not. The seed is gone instead, so
 * `Initial` now means "has not answered" and a `Success` is the server's own
 * answer, whatever `waiting` says about the stream staying open.
 */

import { AsyncResult } from "effect/unstable/reactivity";

export const shouldOfferFirstRun = (
  projects: AsyncResult.AsyncResult<ReadonlyArray<unknown>, unknown>,
): boolean => AsyncResult.isSuccess(projects) && projects.value.length === 0;
