/**
 * The git half of the client runtime: the atoms the changes pane reads.
 *
 * - `gitStatusAtom(projectId)` — `git.status` for the project's workspace.
 * - `gitDiffAtom(range)` — `git.diff` for one comparison. `from`/`to` are the
 *   server's own argument shape: omitting `to` diffs the working tree against
 *   `from` (default `HEAD`), giving both "working tree" and "working tree vs a
 *   turn checkpoint"; supplying both diffs checkpoint to checkpoint.
 *
 * Two deliberate shapes here:
 *
 * 1. Each atom is a **stream driven by the connection's status**, not a
 *    one-shot effect. `SubscriptionRef.changes` replays the current status on
 *    mount, so a pane opened while connected fetches immediately, and a
 *    reconnect (`connected → reconnecting → connected`) refetches by itself.
 *    Offline, the status never reaches `connected`, the stream stays silent and
 *    the atom stays `Initial` — the pane pairs that with the connection state
 *    and says "not connected" rather than "no changes".
 * 2. Failures are **values**, not the atom's error channel (`GitQuery`). A
 *    failed status call must not tear the stream down, or the next reconnect
 *    would have nothing left to refetch on; the pane shows the message and the
 *    same atom recovers on its own.
 *
 * This module is additive on purpose: it takes the `AtomRuntime` that
 * `makeRuntime` already built rather than defining a second one, so the git
 * atoms share one connection with everything else.
 */

import type { ProjectId } from "@OpenAde/contracts/ids";
import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef } from "./connection";

/**
 * A git RPC's outcome as a value. `error` carries the server's message so the
 * pane can show what went wrong (a bad ref, git missing from PATH) and offer a
 * retry, instead of rendering an empty file list that looks like "no changes".
 */
export type GitQuery<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly message: string };

const ok = <A>(value: A): GitQuery<A> => ({ _tag: "ok", value });
const failed = <A>(message: string): GitQuery<A> => ({ _tag: "error", message });

/** Which comparison the pane is showing. `undefined` ends mean the defaults. */
export interface GitDiffRange {
  readonly projectId: ProjectId;
  /** Base ref; `undefined` is the server's default, `HEAD`. */
  readonly from?: string | undefined;
  /** Target ref; `undefined` means the working tree. */
  readonly to?: string | undefined;
}

/**
 * `Atom.family` keys have to be primitives, so a range becomes one string.
 * Keep it a total round trip: the atom decodes the key back into the RPC
 * payload, and a test pins that encode → decode is the identity.
 */
export const encodeDiffRange = (range: GitDiffRange): string =>
  JSON.stringify([range.projectId, range.from ?? null, range.to ?? null]);

export const decodeDiffRange = (key: string): GitDiffRange => {
  const [projectId, from, to] = JSON.parse(key) as [ProjectId, string | null, string | null];
  return {
    projectId,
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
  };
};

/**
 * `git.status` answers `branch: null` with no files both for "not a git
 * repository" and for a project the server does not know — the two cases are
 * indistinguishable on the wire and the pane says the same thing for both.
 */
export const isRepoless = (status: GitStatus): boolean =>
  status.branch === null && status.files.length === 0;

export const makeGitAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second fetch.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const gitStatusAtom = Atom.family((projectId: ProjectId) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["git.status"]({ projectId });
          }).pipe(
            Effect.map(ok<GitStatus>),
            Effect.catch((error) => Effect.succeed(failed<GitStatus>(error.message))),
          ),
        ),
      ),
    ),
  );

  const gitDiffByKeyAtom = Atom.family((key: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const range = decodeDiffRange(key);
            const client = yield* (yield* Connection).client;
            return yield* client["git.diff"]({
              projectId: range.projectId,
              ...(range.from === undefined ? {} : { from: range.from }),
              ...(range.to === undefined ? {} : { to: range.to }),
            });
          }).pipe(
            Effect.map(ok<GitDiff>),
            Effect.catch((error) => Effect.succeed(failed<GitDiff>(error.message))),
          ),
        ),
      ),
    ),
  );

  /** The pane's handle: one atom per comparison, shared across mounts. */
  const gitDiffAtom = (range: GitDiffRange) => gitDiffByKeyAtom(encodeDiffRange(range));

  return { gitStatusAtom, gitDiffAtom };
};

export type GitAtoms = ReturnType<typeof makeGitAtoms>;
