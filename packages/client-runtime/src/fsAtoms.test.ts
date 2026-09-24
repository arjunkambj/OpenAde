/**
 * The folder picker's atoms over a stubbed RPC client. The four behaviours the
 * dialog depends on and cannot get from the server: the request round-trips
 * through its family key, the home request and a typed path are different
 * atoms, a refused path becomes a value with its reason intact instead of
 * killing the atom, and a reconnect relists without anyone asking.
 */

import { describe, expect, it } from "@effect/vitest";
import type { FsListing } from "@poseidon/contracts/rpc";
import { FsBrowseError } from "@poseidon/contracts/rpc";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import {
  decodeFsBrowse,
  encodeFsBrowse,
  makeFsAtoms,
  type FsBrowseKey,
  type FsQuery,
} from "./fsAtoms";
import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const listing = (path: string): FsListing => ({
  path,
  parent: "/Users",
  entries: [{ name: "my-app", path: `${path}/my-app`, isGitRepo: true }],
  truncated: false,
});

/** Every payload `fs.browse` was called with, in order. */
type Calls = Array<{ path?: string; showHidden?: boolean }>;

const fakeClient = (calls: Calls, failing: Ref.Ref<boolean>): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      if (key === "fs.browse") {
        return (payload: { path?: string; showHidden?: boolean }) =>
          Effect.gen(function* () {
            calls.push({ ...payload });
            if (yield* Ref.get(failing)) {
              return yield* Effect.fail(
                new FsBrowseError({
                  reason: "not-found",
                  path: payload.path ?? "",
                  message: "That folder does not exist.",
                }),
              );
            }
            return listing(payload.path ?? "/Users/dev");
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (client: PoseidonRpcClient, initial: ConnectionState) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { registry: AtomRegistry.make(), stateRef, ...makeFsAtoms(base.runtime) };
  });

/** Resolves on the first value matching the predicate — no timers in logic. */
const awaitValue = (
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<FsQuery, Cause.NoSuchElementError>>,
  predicate: (value: FsQuery) => boolean,
): Promise<FsQuery> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<FsQuery, Cause.NoSuchElementError>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("folder picker atoms", () => {
  it("a browse request round-trips through its family key", () => {
    const keys: ReadonlyArray<FsBrowseKey> = [
      { path: null, showHidden: false },
      { path: null, showHidden: true },
      { path: "/Users/dev", showHidden: false },
      { path: "/Users/dev", showHidden: true },
    ];
    for (const key of keys) {
      expect(decodeFsBrowse(encodeFsBrowse(key))).toEqual(key);
    }
    // "the server's home" and a typed path must not collide on one atom, and
    // neither must the same folder with and without hidden entries.
    expect(new Set(keys.map(encodeFsBrowse)).size).toBe(keys.length);
  });

  it.live("omits the path entirely when the dialog opens on the server's home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Calls = [];
        const failing = yield* Ref.make(false);
        const { registry, directoryAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = directoryAtom({ path: null, showHidden: false });
        registry.mount(atom);
        yield* Effect.promise(() => awaitValue(registry, atom, (query) => query._tag === "ok"));
        expect(calls).toEqual([{}]);
      }),
    ),
  );

  it.live("asks for hidden entries only when they were asked for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Calls = [];
        const failing = yield* Ref.make(false);
        const { registry, directoryAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = directoryAtom({ path: "/Users/dev", showHidden: true });
        registry.mount(atom);
        yield* Effect.promise(() => awaitValue(registry, atom, (query) => query._tag === "ok"));
        expect(calls).toEqual([{ path: "/Users/dev", showHidden: true }]);
      }),
    ),
  );

  it.live("a refused path becomes a value, keeps its reason, and the atom survives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Calls = [];
        const failing = yield* Ref.make(true);
        const { registry, stateRef, directoryAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = directoryAtom({ path: "/Users/dev", showHidden: false });
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue(registry, atom, (query) => query._tag === "error"),
        );
        expect(failure).toEqual({
          _tag: "error",
          reason: "not-found",
          message: "That folder does not exist.",
        });

        // The stream is still live: a reconnect relists, and this time it works.
        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue(registry, atom, (query) => query._tag === "ok"),
        );
        expect(recovered._tag === "ok" && recovered.listing.entries[0]?.name).toBe("my-app");
        expect(calls).toHaveLength(2);
      }),
    ),
  );
});
