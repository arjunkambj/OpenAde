/**
 * The folder picker's half of the client runtime: one atom per directory.
 *
 * `directoryAtom({ path, showHidden })` is a `fs.browse` call keyed by exactly
 * what it asks for, so navigating is reading a different member of the family —
 * a folder the user already opened is still in the registry when they walk back
 * up to it, and nothing has to cache by hand.
 *
 * The shape follows `gitAtoms` and `fileAtoms`, for the same two reasons:
 *
 * 1. Each atom is a **stream driven by the connection's status**, so a dialog
 *    opened while connected lists immediately and a reconnect relists by
 *    itself. Offline the stream stays silent and the atom stays `Initial`,
 *    which the dialog pairs with the connection state and reports as "not
 *    connected" rather than as an empty folder.
 * 2. A failed call is a **value**, not the atom's error channel. "That folder
 *    does not exist" is the ordinary answer to a typed path, and it must not
 *    tear down the stream that the next keystroke depends on.
 *
 * It keeps the server's `reason` alongside the message: the dialog offers a
 * different next step for a path that is merely mistyped than for one it is not
 * allowed to open.
 */

import type { FsBrowseError, FsBrowseFailure, FsListing } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import { isTagged } from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { Connection, ConnectionStateRef } from "./connection";

/**
 * A browse outcome as a value. `reason` is the server's classification when it
 * answered at all; a socket that failed underneath is `internal`, which reads
 * the same way to a person and is retried by the same button.
 */
export type FsQuery =
  | { readonly _tag: "ok"; readonly listing: FsListing }
  | { readonly _tag: "error"; readonly reason: FsBrowseFailure; readonly message: string };

/** One `fs.browse` call. `path: null` is "wherever the server opens", its home. */
export interface FsBrowseKey {
  readonly path: string | null;
  readonly showHidden: boolean;
}

/**
 * `Atom.family` keys have to be primitives, so a request becomes one string.
 * Both directions are a total round trip and a test pins it, because the atom
 * decodes the key back into the payload it sends.
 */
export const encodeFsBrowse = (key: FsBrowseKey): string =>
  JSON.stringify([key.path, key.showHidden]);

export const decodeFsBrowse = (encoded: string): FsBrowseKey => {
  const [path, showHidden] = JSON.parse(encoded) as [string | null, boolean];
  return { path, showHidden };
};

/** The server's answer, or the best classification of a transport failure. */
const asQuery = (error: FsBrowseError | RpcClientError.RpcClientError): FsQuery =>
  isTagged(error, "FsBrowseError")
    ? { _tag: "error", reason: error.reason, message: error.message }
    : {
        _tag: "error",
        reason: "internal",
        message: "Could not reach the server to list that folder.",
      };

export const makeFsAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
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

  const directoryByKeyAtom = Atom.family((encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const key = decodeFsBrowse(encoded);
            const client = yield* (yield* Connection).client;
            return yield* client["fs.browse"]({
              ...(key.path === null ? {} : { path: key.path }),
              ...(key.showHidden ? { showHidden: true } : {}),
            });
          }).pipe(
            Effect.map((listing): FsQuery => ({ _tag: "ok", listing })),
            Effect.catch((error) => Effect.succeed(asQuery(error))),
          ),
        ),
      ),
    ),
  );

  /** The dialog's handle: one atom per directory, shared across mounts. */
  const directoryAtom = (key: FsBrowseKey) => directoryByKeyAtom(encodeFsBrowse(key));

  return { directoryAtom };
};

export type FsAtoms = ReturnType<typeof makeFsAtoms>;
