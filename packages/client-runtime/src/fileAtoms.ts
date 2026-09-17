/**
 * The file half of the client runtime: the atoms the dock's Files tab reads.
 *
 * - `fileSearchAtom(query)` — `files.search` over the project's ignore-aware
 *   listing. The server already honours `.gitignore` (and falls back to a
 *   filesystem walk for a folder git does not track), so the renderer asks for
 *   matches and renders whatever comes back.
 * - `fileContentAtom(window)` — one `files.read` window. `offset`/`limit` are
 *   the contract's paging interface, which is how the pane reaches line 20,000
 *   of a file the server would otherwise truncate at its byte cap.
 *
 * The shapes mirror `gitAtoms` on purpose, for the same two reasons:
 *
 * 1. Each atom is a **stream driven by the connection's status** rather than a
 *    one-shot effect, so a pane mounted while connected fetches immediately and
 *    a reconnect refetches by itself. Offline the stream stays silent and the
 *    atom stays `Initial`, which the pane pairs with the connection state and
 *    reports as "not connected" instead of "no files".
 * 2. A failed RPC is a **value** (`FileQuery`), not the atom's error channel. A
 *    bad path must not tear the stream down, or the next reconnect would have
 *    nothing left to refetch on.
 *
 * Additive on purpose: `makeFileAtoms` takes the `AtomRuntime` the app already
 * built, so these atoms share the one socket with everything else.
 */

import type { ProjectId } from "@OpenAde/contracts/ids";
import type { FileContent, FileSearchResult } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef } from "./connection";

/**
 * A file RPC's outcome as a value. `error` carries the server's message — "path
 * escapes the project root", "cannot read …" — so the pane can show what went
 * wrong and offer a retry instead of rendering an empty file that looks real.
 */
export type FileQuery<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly message: string };

const ok = <A>(value: A): FileQuery<A> => ({ _tag: "ok", value });
const failed = <A>(message: string): FileQuery<A> => ({ _tag: "error", message });

/** One `files.search` call. `limit` omitted means the server's own default. */
export interface FileSearchKey {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit?: number | undefined;
}

/** One `files.read` window: lines `[offset, offset + limit)` of `path`. */
export interface FileWindowKey {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
}

/**
 * `Atom.family` keys have to be primitives, so each request shape becomes one
 * string. Both directions are a total round trip and a test pins that, because
 * the atom decodes the key back into the RPC payload it sends.
 */
export const encodeFileSearch = (key: FileSearchKey): string =>
  JSON.stringify([key.projectId, key.query, key.limit ?? null]);

export const decodeFileSearch = (encoded: string): FileSearchKey => {
  const [projectId, query, limit] = JSON.parse(encoded) as [ProjectId, string, number | null];
  return { projectId, query, ...(limit === null ? {} : { limit }) };
};

export const encodeFileWindow = (key: FileWindowKey): string =>
  JSON.stringify([key.projectId, key.path, key.offset, key.limit]);

export const decodeFileWindow = (encoded: string): FileWindowKey => {
  const [projectId, path, offset, limit] = JSON.parse(encoded) as [
    ProjectId,
    string,
    number,
    number,
  ];
  return { projectId, path, offset, limit };
};

export const makeFileAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /**
   * One tick per connected epoch: mount, and every reconnect after that. Kept
   * local rather than shared with `gitAtoms` so neither module has to import
   * the other — it is six lines and the two are independent surfaces.
   */
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

  const fileSearchByKeyAtom = Atom.family((encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const key = decodeFileSearch(encoded);
            const client = yield* (yield* Connection).client;
            return yield* client["files.search"]({
              projectId: key.projectId,
              query: key.query,
              ...(key.limit === undefined ? {} : { limit: key.limit }),
            });
          }).pipe(
            Effect.map(ok<ReadonlyArray<FileSearchResult>>),
            Effect.catch((error) =>
              Effect.succeed(failed<ReadonlyArray<FileSearchResult>>(error.message)),
            ),
          ),
        ),
      ),
    ),
  );

  const fileContentByKeyAtom = Atom.family((encoded: string) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const key = decodeFileWindow(encoded);
            const client = yield* (yield* Connection).client;
            return yield* client["files.read"]({
              projectId: key.projectId,
              path: key.path,
              offset: key.offset,
              limit: key.limit,
            });
          }).pipe(
            Effect.map(ok<FileContent>),
            Effect.catch((error) => Effect.succeed(failed<FileContent>(error.message))),
          ),
        ),
      ),
    ),
  );

  /** The pane's handles: one atom per request, shared across mounts. */
  const fileSearchAtom = (key: FileSearchKey) => fileSearchByKeyAtom(encodeFileSearch(key));
  const fileContentAtom = (key: FileWindowKey) => fileContentByKeyAtom(encodeFileWindow(key));

  return { fileSearchAtom, fileContentAtom };
};

export type FileAtoms = ReturnType<typeof makeFileAtoms>;
