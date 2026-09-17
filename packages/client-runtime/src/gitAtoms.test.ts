/**
 * Git atoms over a stubbed RPC client. The three behaviours the changes pane
 * depends on and cannot get from the server: the range key round-trips, a
 * failed call becomes a value instead of killing the atom, and a reconnect
 * refetches without anyone asking.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId } from "@OpenAde/contracts/ids";
import type { GitDiff, GitStatus } from "@OpenAde/contracts/rpc";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import {
  decodeDiffRange,
  encodeDiffRange,
  isRepoless,
  makeGitAtoms,
  type GitDiffRange,
  type GitQuery,
} from "./gitAtoms";
import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const status = (branch: string | null): GitStatus => ({
  branch,
  upstream: null,
  ahead: 0,
  behind: 0,
  files:
    branch === null ? [] : [{ path: "src/app.ts", status: "modified" as const, staged: false }],
});

const diff = (from: string | null, to: string | null): GitDiff => ({
  from,
  to,
  files: [
    {
      path: "src/app.ts",
      kind: "edit" as const,
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      additions: 3,
      deletions: 1,
    },
  ],
});

interface Calls {
  readonly status: Array<string>;
  readonly diff: Array<{ from?: string; to?: string }>;
}

/**
 * A client whose git calls record their arguments and answer from a mutable
 * script, so a test can make the second call fail or assert it happened.
 */
const fakeClient = (calls: Calls, failStatus: Ref.Ref<boolean>): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      if (key === "git.status") {
        return ({ projectId }: { projectId: string }) =>
          Effect.gen(function* () {
            calls.status.push(projectId);
            if (yield* Ref.get(failStatus)) {
              return yield* Effect.fail({ message: "not a git repository" });
            }
            return status("main");
          });
      }
      if (key === "git.diff") {
        return (payload: { from?: string; to?: string }) =>
          Effect.sync(() => {
            calls.diff.push({ ...payload });
            return diff(payload.from ?? null, payload.to ?? null);
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (client: OpenAdeRpcClient, initial: ConnectionState) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { registry: AtomRegistry.make(), stateRef, ...makeGitAtoms(base.runtime) };
  });

/** Resolves on the first value matching the predicate — no timers in logic. */
const awaitValue = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
): Promise<A> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("git atoms", () => {
  it("a diff range round-trips through its family key", () => {
    const projectId = makeProjectId();
    const ranges: ReadonlyArray<GitDiffRange> = [
      { projectId },
      { projectId, from: "refs/openade/checkpoints/a" },
      { projectId, from: "refs/openade/checkpoints/a", to: "refs/openade/checkpoints/b" },
      { projectId, to: "refs/openade/checkpoints/b" },
    ];
    for (const range of ranges) {
      expect(decodeDiffRange(encodeDiffRange(range))).toEqual(range);
    }
    // Distinct comparisons must not collide on one atom.
    expect(new Set(ranges.map(encodeDiffRange)).size).toBe(ranges.length);
  });

  it("a repo-less status is recognised, a real one is not", () => {
    expect(isRepoless(status(null))).toBe(true);
    expect(isRepoless(status("main"))).toBe(false);
  });

  it.live("a failed status call becomes a value and the atom survives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(true);
        const { registry, stateRef, gitStatusAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = gitStatusAtom(projectId);
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "error",
          ),
        );
        expect(failure).toEqual({ _tag: "error", message: "not a git repository" });

        // The stream is still live: a reconnect refetches, and this time it works.
        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitStatus>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(recovered._tag === "ok" && recovered.value.branch).toBe("main");
        expect(calls.status).toEqual([projectId, projectId]);
      }),
    ),
  );

  it.live("a checkpoint-to-checkpoint range sends both refs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { status: [], diff: [] };
        const failing = yield* Ref.make(false);
        const { registry, gitDiffAtom } = yield* runtimeWith(fakeClient(calls, failing), CONNECTED);

        const worktree = gitDiffAtom({ projectId });
        const between = gitDiffAtom({ projectId, from: "refs/a", to: "refs/b" });
        registry.mount(worktree);
        registry.mount(between);
        yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            worktree,
            (query) => query._tag === "ok" && query.value.to === null,
          ),
        );
        const ranged = yield* Effect.promise(() =>
          awaitValue<GitQuery<GitDiff>, Cause.NoSuchElementError>(
            registry,
            between,
            (query) => query._tag === "ok" && query.value.to === "refs/b",
          ),
        );
        expect(ranged._tag === "ok" && ranged.value.files[0]?.additions).toBe(3);
        // The working-tree atom sends neither ref; the ranged one sends both.
        expect(calls.diff).toContainEqual({ projectId });
        expect(calls.diff).toContainEqual({ projectId, from: "refs/a", to: "refs/b" });
      }),
    ),
  );
});
