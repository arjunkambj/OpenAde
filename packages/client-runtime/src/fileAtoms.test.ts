/**
 * File atoms over a stubbed RPC client. The four behaviours the files pane
 * depends on and cannot get from the server: both family keys round-trip, a
 * failed read becomes a value instead of killing the atom, a reconnect
 * refetches without anyone asking, and a paged window sends the offset and
 * limit it was asked for rather than the server's defaults.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { FileContent, FileSearchResult } from "@OpenAde/contracts/rpc";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  decodeFileSearch,
  decodeFileWindow,
  encodeFileSearch,
  encodeFileWindow,
  makeFileAtoms,
  type FileQuery,
  type FileSearchKey,
  type FileWindowKey,
} from "./fileAtoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

interface Calls {
  readonly search: Array<{ projectId: string; threadId?: string; query: string; limit?: number }>;
  readonly read: Array<{
    projectId: string;
    threadId?: string;
    path: string;
    offset?: number;
    limit?: number;
  }>;
}

const hit = (path: string): FileSearchResult => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDirectory: false,
});

/**
 * A client whose file calls record their arguments and answer from a mutable
 * script, so a test can make the first read fail and assert the retry.
 */
const fakeClient = (calls: Calls, failRead: Ref.Ref<boolean>): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      if (key === "files.search") {
        return (payload: { projectId: string; query: string; limit?: number }) =>
          Effect.sync(() => {
            calls.search.push({ ...payload });
            return payload.query === "" ? [] : [hit(`src/${payload.query}.ts`)];
          });
      }
      if (key === "files.read") {
        return (payload: { projectId: string; path: string; offset?: number; limit?: number }) =>
          Effect.gen(function* () {
            calls.read.push({ ...payload });
            if (yield* Ref.get(failRead)) {
              return yield* Effect.fail({ message: `cannot read ${payload.path}` });
            }
            const offset = payload.offset ?? 0;
            const limit = payload.limit ?? 2;
            const content: FileContent = {
              path: payload.path,
              text: Array.from({ length: limit }, (_, i) => `line ${offset + i}`).join("\n"),
              totalLines: 5_000,
              truncated: offset + limit < 5_000,
            };
            return content;
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
    return { registry: AtomRegistry.make(), stateRef, ...makeFileAtoms(base.runtime) };
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

describe("file atoms", () => {
  it("a search request round-trips through its family key", () => {
    const projectId = makeProjectId();
    const keys: ReadonlyArray<FileSearchKey> = [
      { projectId, query: "" },
      { projectId, query: "router" },
      { projectId, query: "router", limit: 200 },
      { projectId, threadId: makeThreadId(), query: "router" },
    ];
    for (const key of keys) {
      expect(decodeFileSearch(encodeFileSearch(key))).toEqual(key);
    }
    expect(new Set(keys.map(encodeFileSearch)).size).toBe(keys.length);
  });

  it("a read window round-trips through its family key", () => {
    const projectId = makeProjectId();
    const keys: ReadonlyArray<FileWindowKey> = [
      { projectId, path: "src/app.ts", offset: 0, limit: 500 },
      { projectId, path: "src/app.ts", offset: 500, limit: 500 },
      { projectId, path: "src/other.ts", offset: 0, limit: 500 },
      { projectId, threadId: makeThreadId(), path: "src/app.ts", offset: 0, limit: 500 },
    ];
    for (const key of keys) {
      expect(decodeFileWindow(encodeFileWindow(key))).toEqual(key);
    }
    // Two pages of one file must not collide on one atom.
    expect(new Set(keys.map(encodeFileWindow)).size).toBe(keys.length);
  });

  it.live("a failed read becomes a value and the atom survives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [] };
        const failing = yield* Ref.make(true);
        const { registry, stateRef, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = fileContentAtom({ projectId, path: "src/app.ts", offset: 0, limit: 2 });
        registry.mount(atom);
        const failure = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "error",
          ),
        );
        expect(failure).toEqual({ _tag: "error", message: "cannot read src/app.ts" });

        // The stream is still live: a reconnect refetches, and this time it works.
        yield* Ref.set(failing, false);
        yield* SubscriptionRef.set(stateRef, RECONNECTING);
        yield* SubscriptionRef.set(stateRef, CONNECTED);
        const recovered = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(recovered._tag === "ok" && recovered.value.totalLines).toBe(5_000);
        expect(calls.read).toEqual([
          { projectId, path: "src/app.ts", offset: 0, limit: 2 },
          { projectId, path: "src/app.ts", offset: 0, limit: 2 },
        ]);
      }),
    ),
  );

  it.live("a later page asks the server for that window, not the first one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const page = fileContentAtom({ projectId, path: "src/app.ts", offset: 4_000, limit: 2 });
        registry.mount(page);
        const content = yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            page,
            (query) => query._tag === "ok",
          ),
        );
        expect(content._tag === "ok" && content.value.text).toBe("line 4000\nline 4001");
        expect(calls.read).toEqual([{ projectId, path: "src/app.ts", offset: 4_000, limit: 2 }]);
      }),
    ),
  );

  it.live("a search sends the query and the cap it was given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const calls: Calls = { search: [], read: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileSearchAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const atom = fileSearchAtom({ projectId, query: "router", limit: 200 });
        registry.mount(atom);
        const results = yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileSearchResult>>, Cause.NoSuchElementError>(
            registry,
            atom,
            (query) => query._tag === "ok",
          ),
        );
        expect(results._tag === "ok" && results.value.map((r) => r.path)).toEqual([
          "src/router.ts",
        ]);
        expect(calls.search).toEqual([{ projectId, query: "router", limit: 200 }]);
      }),
    ),
  );

  it.live("a thread's search and read send its id, so the server reads the thread's root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const calls: Calls = { search: [], read: [] };
        const failing = yield* Ref.make(false);
        const { registry, fileSearchAtom, fileContentAtom } = yield* runtimeWith(
          fakeClient(calls, failing),
          CONNECTED,
        );

        const search = fileSearchAtom({ projectId, threadId, query: "router" });
        const read = fileContentAtom({ projectId, threadId, path: "a.ts", offset: 0, limit: 2 });
        registry.mount(search);
        registry.mount(read);
        yield* Effect.promise(() =>
          awaitValue<FileQuery<ReadonlyArray<FileSearchResult>>, Cause.NoSuchElementError>(
            registry,
            search,
            (query) => query._tag === "ok",
          ),
        );
        yield* Effect.promise(() =>
          awaitValue<FileQuery<FileContent>, Cause.NoSuchElementError>(
            registry,
            read,
            (query) => query._tag === "ok",
          ),
        );
        expect(calls.search).toEqual([{ projectId, threadId, query: "router" }]);
        expect(calls.read).toEqual([{ projectId, threadId, path: "a.ts", offset: 0, limit: 2 }]);
      }),
    ),
  );
});
