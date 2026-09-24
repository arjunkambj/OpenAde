/**
 * The browser pane's half of the client runtime beyond its state stream: the
 * local dev servers the thread's project is running.
 *
 * `devServersAtom(threadId)` is `browser.discoverServers`, fetched when
 * something mounts it — the address bar's suggestions opening, the empty pane
 * — and again on every reconnect; refreshing the atom asks again. The server
 * scans on demand and reuses an answer for a few seconds, so a refresh per
 * popover is cheap.
 *
 * A failed call is an empty list, never the atom's error: a suggestion the
 * pane cannot make is not something to show a person an error for, and the
 * stream has to survive to refetch after the next reconnect. Offline, the
 * atom keeps its initial empty list.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { DevServer } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef } from "./connection";

const NONE: ReadonlyArray<DevServer> = [];

export const makeBrowserAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const devServersAtom = Atom.family((threadId: ThreadId) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const client = yield* (yield* Connection).client;
            return yield* client["browser.discoverServers"]({ threadId });
          }).pipe(Effect.catch(() => Effect.succeed(NONE))),
        ),
      ),
      { initialValue: NONE },
    ),
  );

  return { devServersAtom };
};

export type BrowserAtoms = ReturnType<typeof makeBrowserAtoms>;
