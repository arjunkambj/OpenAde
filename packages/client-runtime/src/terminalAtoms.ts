/**
 * The integrated terminal's half of the client runtime.
 *
 * - `terminalListAtom(threadId)` — `terminal.list`, refetched on every
 *   connected epoch and after `openTerminal` / `closeTerminal`. A failure is a
 *   value (`TerminalListQuery`), not the atom's error channel, so the drawer
 *   can say what went wrong and the next reconnect still has a stream to
 *   refetch on.
 * - `openTerminal`, `writeTerminal`, `resizeTerminal`, `closeTerminal` — the
 *   four calls, as `runtime.fn`s.
 * - `terminalAttachAtom(key)` — the output of one terminal, handed to a
 *   callback item by item.
 *
 * Output is deliberately **not** an atom over the subscribe stream. An atom
 * built from a stream keeps only the last element of each chunk the stream
 * emits, which for a terminal would silently drop bytes whenever the socket
 * delivers two items at once. The attach atom is a `runtime.fn` instead: the
 * renderer sets it with a callback on mount and resets it on unmount, which
 * interrupts the run, and every item reaches the callback, in order.
 *
 * Every fn here is `concurrent`. A plain `runtime.fn` interrupts its previous
 * run when it is set again, which would cancel the first of two tabs opening
 * together and drop keystrokes typed while an earlier one was in flight. Input
 * goes through one lane per terminal instead (`makeInputLanes`), so it reaches
 * the shell in the order it was typed however the calls are scheduled.
 *
 * Like the other atom modules, this takes the `AtomRuntime` that `makeRuntime`
 * already built, so the terminal shares one connection with everything else.
 */

import type { TerminalId, ThreadId } from "@OpenAde/contracts/ids";
import type { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import {
  TERMINAL_WRITE_MAX_CHARS,
  type TerminalSize,
  type TerminalStreamItem,
  type TerminalSummary,
} from "@OpenAde/contracts/terminal";
import * as Effect from "effect/Effect";
import { isTagged } from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { transportOnly } from "./atoms";
import { Connection, ConnectionStateRef } from "./connection";

/** `terminal.list` as a value: the thread's terminals, or why they could not be listed. */
export type TerminalListQuery =
  | { readonly _tag: "ok"; readonly terminals: ReadonlyArray<TerminalSummary> }
  | { readonly _tag: "error"; readonly message: string };

/** One terminal, as every call after `open` names it. */
export interface TerminalRef {
  readonly threadId: ThreadId;
  readonly terminalId: TerminalId;
}

export interface TerminalOpenArgs extends TerminalRef, TerminalSize {
  readonly title?: string | undefined;
}

/**
 * What the attach callback receives: every stream item as the server sent it,
 * plus `gone` when the server no longer knows the terminal — after a server
 * restart, say, since scrollback lives only in memory. `gone` is the last call.
 */
export type TerminalAttachItem = TerminalStreamItem | { readonly kind: "gone" };

/**
 * `Atom.family` keys have to be primitives, so a terminal becomes one string.
 * Ids are UUIDs and never contain the separator; a test pins the round trip.
 */
export const encodeTerminalKey = (ref: TerminalRef): string => `${ref.threadId}:${ref.terminalId}`;

export const decodeTerminalKey = (key: string): TerminalRef => {
  const separator = key.indexOf(":");
  return {
    threadId: key.slice(0, separator) as ThreadId,
    terminalId: key.slice(separator + 1) as TerminalId,
  };
};

type TerminalRpcError = OpenAdeRpcError | RpcClientError.RpcClientError;

const isGone = (error: TerminalRpcError): boolean =>
  isTagged(error, "OpenAdeRpcError") && error.code === "not-found";

/**
 * One subscription, run to its end with every item handed to `onItem`.
 * Succeeds with whether it ended on `resnapshot-required` — the one clean end
 * that asks the client to subscribe again. After `exited` nothing can follow.
 */
const attachOnce = (
  ref: TerminalRef,
  onItem: (item: TerminalAttachItem) => void,
): Effect.Effect<boolean, TerminalRpcError, Connection> =>
  Effect.gen(function* () {
    const client = yield* (yield* Connection).client;
    let resnapshot = false;
    yield* Stream.runForEach(client["terminal.subscribe"](ref), (item) =>
      Effect.sync(() => {
        resnapshot = item.kind === "resnapshot-required";
        onItem(item);
      }),
    );
    return resnapshot;
  });

/**
 * Attach until the terminal is done with: a dropped socket retries on the
 * fresh one, a subscriber that fell behind resubscribes, and both begin again
 * with a `snapshot` the renderer resets to. A terminal the server does not know
 * is reported once as `gone` rather than retried; any other refusal from the
 * server fails the run.
 */
const attach = (
  ref: TerminalRef,
  onItem: (item: TerminalAttachItem) => void,
): Effect.Effect<void, TerminalRpcError, Connection> => {
  const loop: Effect.Effect<void, TerminalRpcError, Connection> = attachOnce(ref, onItem).pipe(
    Effect.retry(transportOnly<TerminalRpcError>()),
    Effect.flatMap((again) => (again ? Effect.suspend(() => loop) : Effect.void)),
  );
  return loop.pipe(Effect.catchIf(isGone, () => Effect.sync(() => onItem({ kind: "gone" }))));
};

/** The longest prefix of `data` that fits one write and does not split a surrogate pair. */
const nextWrite = (data: string): string => {
  if (data.length <= TERMINAL_WRITE_MAX_CHARS) return data;
  const end = TERMINAL_WRITE_MAX_CHARS;
  const high = data.charCodeAt(end - 1);
  return data.slice(0, high >= 0xd800 && high <= 0xdbff ? end - 1 : end);
};

/**
 * Input queued per terminal and sent by one sender at a time. A call appends
 * to its terminal's pending input synchronously, then whichever call holds the
 * lock sends everything pending, so keys typed while a write is in flight
 * leave together as the next write, in order. A resize keeps only the latest
 * size.
 */
const makeInputLanes = () => {
  const lock = Semaphore.makeUnsafe(1);
  const pending = new Map<string, { data: string; size: TerminalSize | null }>();

  const laneOf = (key: string) => {
    let lane = pending.get(key);
    if (lane === undefined) {
      lane = { data: "", size: null };
      pending.set(key, lane);
    }
    return lane;
  };

  const flush = (key: string): Effect.Effect<void, TerminalRpcError, Connection> =>
    Effect.gen(function* () {
      const ref = decodeTerminalKey(key);
      const client = yield* (yield* Connection).client;
      for (let lane = pending.get(key); lane !== undefined; lane = pending.get(key)) {
        if (lane.size !== null) {
          const size = lane.size;
          lane.size = null;
          yield* client["terminal.resize"]({ ...ref, ...size });
        } else if (lane.data.length > 0) {
          const data = nextWrite(lane.data);
          lane.data = lane.data.slice(data.length);
          yield* client["terminal.write"]({ ...ref, data });
        } else {
          pending.delete(key);
        }
      }
    }).pipe(lock.withPermits(1));

  const write = (ref: TerminalRef, data: string) =>
    Effect.suspend(() => {
      const key = encodeTerminalKey(ref);
      laneOf(key).data += data;
      return flush(key);
    });

  const resize = (ref: TerminalRef, size: TerminalSize) =>
    Effect.suspend(() => {
      const key = encodeTerminalKey(ref);
      laneOf(key).size = { cols: size.cols, rows: size.rows };
      return flush(key);
    });

  return { write, resize };
};

export const makeTerminalAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second listing.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const terminalListAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["terminal.list"]({ threadId });
          }).pipe(
            Effect.map((terminals): TerminalListQuery => ({ _tag: "ok", terminals })),
            Effect.catch((error) =>
              Effect.succeed<TerminalListQuery>({ _tag: "error", message: error.message }),
            ),
          ),
        ),
      ),
    ),
  );

  /**
   * Starts the shell, or answers the one already running under this id. The
   * list is refetched whatever the outcome: it is the truth either way.
   */
  const openTerminal = runtime.fn(
    ({ title, ...args }: TerminalOpenArgs, get) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["terminal.open"]({
          ...args,
          ...(title === undefined ? {} : { title }),
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => get.registry.refresh(terminalListAtom(args.threadId)))),
      ),
    { concurrent: true },
  );

  /** Kills the shell and forgets it; the list is refetched whatever the outcome. */
  const closeTerminal = runtime.fn(
    (ref: TerminalRef, get) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        yield* client["terminal.close"](ref);
      }).pipe(
        Effect.ensuring(Effect.sync(() => get.registry.refresh(terminalListAtom(ref.threadId)))),
      ),
    { concurrent: true },
  );

  const lanes = makeInputLanes();

  /** Typed keys or a paste, delivered to the shell in the order they were written. */
  const writeTerminal = runtime.fn(
    (args: TerminalRef & { readonly data: string }) =>
      lanes.write({ threadId: args.threadId, terminalId: args.terminalId }, args.data),
    { concurrent: true },
  );

  /** A new grid size; sizes queued behind an in-flight call collapse to the latest. */
  const resizeTerminal = runtime.fn(
    (args: TerminalRef & TerminalSize) =>
      lanes.resize({ threadId: args.threadId, terminalId: args.terminalId }, args),
    { concurrent: true },
  );

  /**
   * One terminal's output, keyed by `encodeTerminalKey`. Set it with the
   * callback that feeds the renderer's terminal; set it again (or reset it) to
   * stop. Not concurrent on purpose: a new callback replaces the old one.
   */
  const terminalAttachAtom = Atom.family((key: string) =>
    runtime.fn((onItem: (item: TerminalAttachItem) => void) =>
      attach(decodeTerminalKey(key), onItem),
    ),
  );

  return {
    terminalListAtom,
    openTerminal,
    writeTerminal,
    resizeTerminal,
    closeTerminal,
    terminalAttachAtom,
  };
};

export type TerminalAtoms = ReturnType<typeof makeTerminalAtoms>;
