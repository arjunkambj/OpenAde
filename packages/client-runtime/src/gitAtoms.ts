/**
 * The git half of the client runtime: the atoms the changes pane reads.
 *
 * - `gitStatusAtom(scope)` — `git.status` for the project's workspace, or for
 *   a thread's own root (its worktree) when the scope names the thread.
 * - `gitDiffAtom(range)` — `git.diff` for one comparison. `from`/`to` are the
 *   server's own argument shape: omitting `to` diffs the working tree against
 *   `from` (default `HEAD`), giving both "working tree" and "working tree vs a
 *   turn checkpoint"; supplying both diffs checkpoint to checkpoint, and
 *   `mergeBase` diffs the working tree against where the branch forked.
 * - `gitBranchesAtom(scope)` — `git.branches`, the branch picker's list.
 * - `gitCreateBranchAtom` / `gitCheckoutAtom` — the picker's two writes. Each
 *   resolves with the new branch list and refreshes that scope's branch and
 *   status atoms, so the header and the Changes pane follow the switch.
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

import type { GitBranchList } from "@OpenAde/contracts/git";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
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

/**
 * Which directory a git read runs in: the thread's own root when `threadId`
 * is set — its worktree, when it has one — and the project's otherwise.
 */
export interface GitScope {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

/** `Atom.family` keys have to be primitives; a test pins the round trip. */
export const encodeGitScope = (scope: GitScope): string =>
  JSON.stringify([scope.projectId, scope.threadId ?? null]);

export const decodeGitScope = (key: string): GitScope => {
  const [projectId, threadId] = JSON.parse(key) as [ProjectId, ThreadId | null];
  return { projectId, ...(threadId === null ? {} : { threadId }) };
};

/** Which comparison the pane is showing. `undefined` ends mean the defaults. */
export interface GitDiffRange extends GitScope {
  /** Base ref; `undefined` is the server's default, `HEAD`. */
  readonly from?: string | undefined;
  /** Target ref; `undefined` means the working tree. */
  readonly to?: string | undefined;
  /** Diff the working tree against the merge base of `HEAD` and this ref. */
  readonly mergeBase?: string | undefined;
}

/**
 * `Atom.family` keys have to be primitives, so a range becomes one string.
 * Keep it a total round trip: the atom decodes the key back into the RPC
 * payload, and a test pins that encode → decode is the identity.
 */
export const encodeDiffRange = (range: GitDiffRange): string =>
  JSON.stringify([
    range.projectId,
    range.threadId ?? null,
    range.from ?? null,
    range.to ?? null,
    range.mergeBase ?? null,
  ]);

export const decodeDiffRange = (key: string): GitDiffRange => {
  const [projectId, threadId, from, to, mergeBase] = JSON.parse(key) as [
    ProjectId,
    ThreadId | null,
    string | null,
    string | null,
    string | null,
  ];
  return {
    projectId,
    ...(threadId === null ? {} : { threadId }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
    ...(mergeBase === null ? {} : { mergeBase }),
  };
};

/** The branch picker's "new branch": cut from `from` (default `HEAD`), switched to when `checkout`. */
export interface GitCreateBranch extends GitScope {
  readonly name: string;
  readonly from?: string | undefined;
  readonly checkout: boolean;
}

/** The branch picker's switch: a local branch, or a remote one to track. */
export interface GitCheckout extends GitScope {
  readonly branch: string;
}

/** The scope half of a payload, without an absent `threadId` on the wire. */
const scopePayload = (scope: GitScope) => ({
  projectId: scope.projectId,
  ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
});

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

  const gitStatusByKeyAtom = Atom.family((key: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const scope = decodeGitScope(key);
            const client = yield* (yield* Connection).client;
            return yield* client["git.status"]({
              projectId: scope.projectId,
              ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            });
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
              ...(range.threadId === undefined ? {} : { threadId: range.threadId }),
              ...(range.from === undefined ? {} : { from: range.from }),
              ...(range.to === undefined ? {} : { to: range.to }),
              ...(range.mergeBase === undefined ? {} : { mergeBase: range.mergeBase }),
            });
          }).pipe(
            Effect.map(ok<GitDiff>),
            Effect.catch((error) => Effect.succeed(failed<GitDiff>(error.message))),
          ),
        ),
      ),
    ),
  );

  const gitBranchesByKeyAtom = Atom.family((key: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["git.branches"](scopePayload(decodeGitScope(key)));
          }).pipe(
            Effect.map(ok<GitBranchList>),
            Effect.catch((error) => Effect.succeed(failed<GitBranchList>(error.message))),
          ),
        ),
      ),
    ),
  );

  /** The pane's handles: one atom per scope and per comparison, shared across mounts. */
  const gitStatusAtom = (scope: GitScope) => gitStatusByKeyAtom(encodeGitScope(scope));
  const gitDiffAtom = (range: GitDiffRange) => gitDiffByKeyAtom(encodeDiffRange(range));
  const gitBranchesAtom = (scope: GitScope) => gitBranchesByKeyAtom(encodeGitScope(scope));

  /**
   * After a branch write the scope's branch list and status are stale: the
   * current branch moved, and so did what the working tree is compared with.
   * Refreshing restarts each stream, which refetches on the replayed status.
   */
  const refreshScope = (registry: AtomRegistry.AtomRegistry, scope: GitScope) => {
    const key = encodeGitScope(scope);
    registry.refresh(gitBranchesByKeyAtom(key));
    registry.refresh(gitStatusByKeyAtom(key));
  };

  /** Fails with the server's refusal (a bad name, a dirty tree) for the caller to show. */
  const gitCreateBranchAtom = runtime.fn((input: GitCreateBranch, get) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const list = yield* client["git.branch.create"]({
        ...scopePayload(input),
        name: input.name,
        ...(input.from === undefined ? {} : { from: input.from }),
        checkout: input.checkout,
      });
      refreshScope(get.registry, input);
      return list;
    }),
  );

  /** Fails with `conflict` on a dirty tracked tree or a running turn in that root. */
  const gitCheckoutAtom = runtime.fn((input: GitCheckout, get) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      const list = yield* client["git.checkout"]({
        ...scopePayload(input),
        branch: input.branch,
      });
      refreshScope(get.registry, input);
      return list;
    }),
  );

  return { gitStatusAtom, gitDiffAtom, gitBranchesAtom, gitCreateBranchAtom, gitCheckoutAtom };
};

export type GitAtoms = ReturnType<typeof makeGitAtoms>;
