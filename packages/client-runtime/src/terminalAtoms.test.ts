/**
 * Terminal atoms over a stubbed RPC client. What the drawer depends on and
 * cannot get from the server: every output item reaches the callback even when
 * several arrive in one chunk, an overflow or a dropped socket reattaches with
 * a fresh snapshot, a terminal the server forgot is reported once as `gone`,
 * the list follows reconnects and opens, input reaches the shell in order, and
 * a failed write does not leave the rest of a paste to arrive later.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeTerminalId, makeThreadId } from "@OpenAde/contracts/ids";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import {
  TERMINAL_WRITE_MAX_CHARS,
  type TerminalStreamItem,
  type TerminalSummary,
} from "@OpenAde/contracts/terminal";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";
import {
  decodeTerminalKey,
  encodeTerminalKey,
  makeTerminalAtoms,
  type TerminalAttachItem,
  type TerminalListQuery,
  type TerminalRef,
} from "./terminalAtoms";

const CONNECTED: ConnectionState = { status: "connected", serverInstanceId: null };
const RECONNECTING: ConnectionState = { status: "reconnecting", serverInstanceId: null };

const summary = (ref: TerminalRef): TerminalSummary => ({
  ...ref,
  title: "zsh",
  cwd: "/repo",
  pid: 4242,
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const snapshot = (ref: TerminalRef, data: string): TerminalStreamItem => ({
  kind: "snapshot",
  terminal: summary(ref),
  data,
  offset: data.length,
});

const output = (data: string, offset: number): TerminalStreamItem => ({
  kind: "output",
  data,
  offset,
});

/** One scripted `terminal.subscribe` answer: its items, or the failure it ends in. */
type Subscription =
  | { readonly items: ReadonlyArray<TerminalStreamItem> }
  | { readonly fail: unknown };

interface Script {
  /** Answers in call order; a call past the end never emits, like an idle shell. */
  readonly subscriptions: Array<Subscription>;
  subscribeCalls: number;
  listCalls: number;
  readonly terminals: Array<TerminalSummary>;
  /** `terminal.write` and `terminal.resize` payloads, in the order they arrived. */
  readonly input: Array<string>;
  /** When set, the first write waits on it, so a test can queue more behind it. */
  gate?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
  /** Failures the next writes end in, one each, recorded as `failed <length>`. */
  readonly writeFailures: Array<unknown>;
  /** Called after each write or resize is recorded, failed or not. */
  readonly onInput: Set<() => void>;
}

const newScript = (subscriptions: Array<Subscription> = []): Script => ({
  subscriptions,
  subscribeCalls: 0,
  listCalls: 0,
  terminals: [],
  input: [],
  writeFailures: [],
  onInput: new Set(),
});

/**
 * Resolves once `count` writes and resizes have reached the stub. A failed run
 * leaves the fn's atom a failure, so this waits on the stub, not the atom.
 */
const awaitInput = (script: Script, count: number): Promise<void> =>
  new Promise((resolve) => {
    const check = () => {
      if (script.input.length < count) return;
      script.onInput.delete(check);
      resolve();
    };
    script.onInput.add(check);
    check();
  });

const record = (script: Script, line: string) => {
  script.input.push(line);
  for (const listener of script.onInput) listener();
};

const fakeClient = (script: Script): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "terminal.subscribe":
          return () => {
            const answer = script.subscriptions[script.subscribeCalls];
            script.subscribeCalls += 1;
            if (answer === undefined) return Stream.never;
            return "fail" in answer ? Stream.fail(answer.fail) : Stream.fromIterable(answer.items);
          };
        case "terminal.list":
          return () =>
            Effect.sync(() => {
              script.listCalls += 1;
              return [...script.terminals];
            });
        case "terminal.open":
          return (payload: TerminalRef) =>
            Effect.sync(() => {
              const opened = summary({
                threadId: payload.threadId,
                terminalId: payload.terminalId,
              });
              script.terminals.push(opened);
              return opened;
            });
        case "terminal.write":
          return (payload: { data: string }) =>
            Effect.gen(function* () {
              const gate = script.gate;
              if (gate !== undefined) {
                script.gate = undefined;
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
              if (script.writeFailures.length > 0) {
                record(script, `failed ${payload.data.length}`);
                return yield* Effect.fail(script.writeFailures.shift());
              }
              record(script, `write ${payload.data}`);
            });
        case "terminal.resize":
          return (payload: { cols: number; rows: number }) =>
            Effect.sync(() => {
              record(script, `resize ${payload.cols}x${payload.rows}`);
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const runtimeWith = (script: Script, initial: ConnectionState = CONNECTED) =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial);
    const layer = Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(fakeClient(script)), state: stateRef }),
      Layer.succeed(ConnectionStateRef, stateRef),
    );
    const base = makeRuntime(layer);
    return { registry: AtomRegistry.make(), stateRef, ...makeTerminalAtoms(base.runtime) };
  });

/** Resolves on the first value matching the predicate — no timers in logic. */
const awaitValue = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean = () => true,
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

/**
 * Attaches with a recording callback and resolves once the run has ended,
 * with everything the callback was handed.
 */
const attachUntilDone = (
  atoms: Effect.Success<ReturnType<typeof runtimeWith>>,
  ref: TerminalRef,
): Promise<Array<TerminalAttachItem>> => {
  const received: Array<TerminalAttachItem> = [];
  const atom = atoms.terminalAttachAtom(encodeTerminalKey(ref));
  atoms.registry.mount(atom);
  atoms.registry.set(atom, (item) => received.push(item));
  return awaitValue(atoms.registry, atom).then(() => received);
};

const newRef = (): TerminalRef => ({ threadId: makeThreadId(), terminalId: makeTerminalId() });

describe("terminal atoms", () => {
  it("a terminal round-trips through its family key", () => {
    const refs = [newRef(), newRef()];
    for (const ref of refs) {
      expect(decodeTerminalKey(encodeTerminalKey(ref))).toEqual(ref);
    }
    expect(new Set(refs.map(encodeTerminalKey)).size).toBe(refs.length);
  });

  it.live("hands the callback every item of a single chunk, in order", () =>
    Effect.gen(function* () {
      const ref = newRef();
      // One chunk of four: an atom over this stream would keep only the last.
      const burst = [snapshot(ref, "$ "), output("a", 3), output("b", 4), output("c", 5)];
      const atoms = yield* runtimeWith(newScript([{ items: burst }]));

      const received = yield* Effect.promise(() => attachUntilDone(atoms, ref));
      expect(received).toEqual(burst);
    }),
  );

  it.live("resubscribes after resnapshot-required and starts again from a snapshot", () =>
    Effect.gen(function* () {
      const ref = newRef();
      const first = [snapshot(ref, "one\n"), { kind: "resnapshot-required", reason: "budget" }];
      const second = [
        snapshot(ref, "one\ntwo\n"),
        { kind: "exited", exitCode: 0, signal: null },
      ] satisfies Array<TerminalStreamItem>;
      const script = newScript([{ items: first as Array<TerminalStreamItem> }, { items: second }]);
      const atoms = yield* runtimeWith(script);

      const received = yield* Effect.promise(() => attachUntilDone(atoms, ref));
      expect(received.map((item) => item.kind)).toEqual([
        "snapshot",
        "resnapshot-required",
        "snapshot",
        "exited",
      ]);
      expect(received[2]).toEqual(second[0]);
      // `exited` ends the run: nothing asks for a third subscription.
      expect(script.subscribeCalls).toBe(2);
    }),
  );

  it.live("retries a dropped socket and reattaches with a fresh snapshot", () =>
    Effect.gen(function* () {
      const ref = newRef();
      const script = newScript([
        { fail: { _tag: "RpcClientError", message: "socket closed" } },
        { items: [snapshot(ref, "back\n"), { kind: "exited", exitCode: 0, signal: null }] },
      ]);
      const atoms = yield* runtimeWith(script);

      const received = yield* Effect.promise(() => attachUntilDone(atoms, ref));
      expect(received.map((item) => item.kind)).toEqual(["snapshot", "exited"]);
      expect(script.subscribeCalls).toBe(2);
    }),
  );

  it.live("a terminal the server does not know is reported as gone, once", () =>
    Effect.gen(function* () {
      const ref = newRef();
      const script = newScript([
        { fail: new OpenAdeRpcError({ code: "not-found", message: "no such terminal" }) },
        { items: [snapshot(ref, "must not be asked for")] },
      ]);
      const atoms = yield* runtimeWith(script);

      const received = yield* Effect.promise(() => attachUntilDone(atoms, ref));
      expect(received).toEqual([{ kind: "gone" }]);
      expect(script.subscribeCalls).toBe(1);
    }),
  );

  it.live("the list refetches on reconnect and after a terminal is opened", () =>
    Effect.gen(function* () {
      const ref = newRef();
      const script = newScript();
      const { registry, stateRef, terminalListAtom, openTerminal } = yield* runtimeWith(script);
      const list = terminalListAtom(ref.threadId);
      registry.mount(list);
      registry.mount(openTerminal);

      const isOk =
        (length: number) =>
        (query: TerminalListQuery): boolean =>
          query._tag === "ok" && query.terminals.length === length;
      yield* Effect.promise(() => awaitValue(registry, list, isOk(0)));
      expect(script.listCalls).toBe(1);

      registry.set(openTerminal, { ...ref, cols: 80, rows: 24 });
      const opened = yield* Effect.promise(() => awaitValue(registry, list, isOk(1)));
      expect(opened._tag === "ok" && opened.terminals[0]?.terminalId).toBe(ref.terminalId);
      expect(script.listCalls).toBe(2);

      // A terminal another window opened while this one was offline: only the
      // reconnect can tell this client about it.
      script.terminals.push(summary(newRef()));
      yield* SubscriptionRef.set(stateRef, RECONNECTING);
      yield* SubscriptionRef.set(stateRef, CONNECTED);
      yield* Effect.promise(() => awaitValue(registry, list, isOk(2)));
      expect(script.listCalls).toBe(3);
    }),
  );

  it.live("input typed while a write is in flight follows it, in order, as one write", () =>
    Effect.gen(function* () {
      const ref = newRef();
      const script = newScript();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      script.gate = { entered, release };
      const { registry, writeTerminal, resizeTerminal } = yield* runtimeWith(script);
      registry.mount(writeTerminal);
      registry.mount(resizeTerminal);

      registry.set(writeTerminal, { ...ref, data: "l" });
      yield* Deferred.await(entered);
      registry.set(writeTerminal, { ...ref, data: "s" });
      registry.set(resizeTerminal, { ...ref, cols: 100, rows: 30 });
      registry.set(resizeTerminal, { ...ref, cols: 120, rows: 40 });
      registry.set(writeTerminal, { ...ref, data: "\r" });
      yield* Deferred.succeed(release, undefined);

      yield* Effect.promise(() =>
        awaitValue(registry, writeTerminal, () => script.input.length === 3),
      );
      // The queued keys leave together after the first; only the last size is sent.
      expect(script.input).toEqual(["write l", "resize 120x40", "write s\r"]);
    }),
  );

  /** A paste one write cannot hold, whose first write waits on the gate. */
  const pasteThroughGate = (script: Script) =>
    Effect.gen(function* () {
      const ref = newRef();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      script.gate = { entered, release };
      const atoms = yield* runtimeWith(script);
      atoms.registry.mount(atoms.writeTerminal);
      atoms.registry.set(atoms.writeTerminal, {
        ...ref,
        data: "p".repeat(TERMINAL_WRITE_MAX_CHARS + 5),
      });
      yield* Deferred.await(entered);
      return { ...atoms, ref, release };
    });

  it.live("a failed write drops the rest of its paste but not what was typed after", () =>
    Effect.gen(function* () {
      const script = newScript();
      script.writeFailures.push({ _tag: "RpcClientError", message: "socket closed" });
      const { registry, writeTerminal, ref, release } = yield* pasteThroughGate(script);
      registry.set(writeTerminal, { ...ref, data: "y" });
      yield* Deferred.succeed(release, undefined);

      yield* Effect.promise(() => awaitInput(script, 2));
      expect(script.input).toEqual([`failed ${TERMINAL_WRITE_MAX_CHARS}`, "write y"]);
    }),
  );

  it.live("a write answered not-found drops everything queued for that terminal", () =>
    Effect.gen(function* () {
      const script = newScript();
      script.writeFailures.push(new OpenAdeRpcError({ code: "not-found", message: "closed" }));
      const { registry, writeTerminal, ref, release } = yield* pasteThroughGate(script);
      registry.set(writeTerminal, { ...ref, data: "y" });
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => awaitInput(script, 1));

      registry.set(writeTerminal, { ...ref, data: "z" });
      yield* Effect.promise(() => awaitInput(script, 2));
      expect(script.input).toEqual([`failed ${TERMINAL_WRITE_MAX_CHARS}`, "write z"]);
    }),
  );
});
