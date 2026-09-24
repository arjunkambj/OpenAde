/**
 * `devServersAtom` over a stubbed RPC client: it asks for the thread it is
 * keyed by, a failed call reads as no servers rather than an error, and the
 * stream survives that failure to ask again after a reconnect.
 */

import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { OpenAdeRpcError, type DevServer } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeBrowserAtoms } from "./browserAtoms";
import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };
const THREAD = "0190aaaa-0000-7000-8000-000000000001" as ThreadId;
const VITE: DevServer = { url: "http://localhost:5173", port: 5173, processName: "node" };

const fakeClient = (calls: Array<unknown>, failing: Ref.Ref<boolean>): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      if (key === "browser.discoverServers") {
        return (payload: unknown) =>
          Effect.gen(function* () {
            calls.push(payload);
            if (yield* Ref.get(failing)) {
              return yield* Effect.fail(
                new OpenAdeRpcError({ code: "internal", message: "internal error" }),
              );
            }
            return [VITE];
          });
      }
      return () => Effect.die(`unimplemented rpc ${String(key)}`);
    },
  });

const runtimeWith = (client: OpenAdeRpcClient) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(CONNECTED);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { registry: AtomRegistry.make(), stateRef, ...makeBrowserAtoms(base.runtime) };
  });

/** Resolves on the first list the predicate accepts — no timers in logic. */
const awaitList = (
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<DevServer>, unknown>>,
  predicate: (servers: ReadonlyArray<DevServer>) => boolean,
): Promise<ReadonlyArray<DevServer>> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<ReadonlyArray<DevServer>, unknown>) => {
      if (AsyncResult.isSuccess(result) && predicate(result.value)) {
        unmount();
        resolve(result.value);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("devServersAtom", () => {
  it.live("asks for its own thread and answers the servers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const failing = yield* Ref.make(false);
        const { registry, devServersAtom } = yield* runtimeWith(fakeClient(calls, failing));
        const atom = devServersAtom(THREAD);
        registry.mount(atom);
        const servers = yield* Effect.promise(() =>
          awaitList(registry, atom, (list) => list.length > 0),
        );
        expect(servers).toEqual([VITE]);
        expect(calls).toEqual([{ threadId: THREAD }]);
      }),
    ),
  );

  it.live("reads a failed call as no servers, and asks again after a reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const failing = yield* Ref.make(true);
        const { registry, stateRef, devServersAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
        );
        const atom = devServersAtom(THREAD);
        registry.mount(atom);
        yield* Effect.promise(() => awaitList(registry, atom, () => calls.length === 1));
        expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);

        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const servers = yield* Effect.promise(() =>
          awaitList(registry, atom, (list) => list.length > 0),
        );
        expect(servers).toEqual([VITE]);
        expect(calls).toHaveLength(2);
      }),
    ),
  );
});

describe("browserStatusAtom", () => {
  it.live("answers the server's browser status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const status = { mode: "in-app", installed: true, version: "agent-browser 0.38.1" };
        const client = new Proxy({} as OpenAdeRpcClient, {
          get: (_target, key) =>
            key === "browser.status"
              ? () => Effect.succeed(status)
              : () => Effect.die(`unimplemented rpc ${String(key)}`),
        });
        const { registry, browserStatusAtom } = yield* runtimeWith(client);
        const answered = yield* Effect.promise(
          () =>
            new Promise((resolve) => {
              const check = (result: AsyncResult.AsyncResult<unknown, unknown>) => {
                if (AsyncResult.isSuccess(result) && result.value !== null) {
                  unmount();
                  resolve(result.value);
                }
              };
              const unmount = registry.subscribe(browserStatusAtom, check);
              check(registry.get(browserStatusAtom));
            }),
        );
        expect(answered).toEqual(status);
      }),
    ),
  );
});
