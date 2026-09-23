/**
 * The connector half of the client runtime: what every model picker lists.
 *
 * `modelCatalogAtom` is one entry per *enabled* connector instance, in the
 * order `connectors.list` answers — the settings document's order, which is
 * the order the connectors page shows and the one the server's fallback
 * routing reads. Each entry carries the instance's summary beside its models,
 * so a picker can head a section with the instance's name and hand back which
 * instance a model was picked under: two instances of one harness list the
 * same model ids, and only the pair says which one a thread runs on.
 *
 * It reads `connectorsAtom` rather than fetching the list itself, so it
 * follows everything that atom already follows — a reconnect, the settings
 * page's probe button — without a second invalidation path. A single
 * instance whose `connectors.models` fails lists no models; the others are
 * unaffected, because one broken harness must not empty the picker.
 *
 * Additive on purpose, like the git and file atoms: `makeConnectorAtoms`
 * takes the `AtomRuntime` `makeRuntime` built, so these share its socket.
 */

import type { ConnectorSummary, ModelOption } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import type { AsyncResult } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, type ConnectionStateRef } from "./connection";

/** One enabled connector instance and the models it advertises. */
export interface ConnectorModels {
  readonly connector: ConnectorSummary;
  readonly models: ReadonlyArray<ModelOption>;
}

export const makeConnectorAtoms = <E>(
  runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>,
  connectorsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<ConnectorSummary>, E>>,
) => {
  const modelCatalogAtom = runtime.atom(
    (get) =>
      Effect.gen(function* () {
        const connectors = yield* get.result(connectorsAtom);
        return yield* Effect.forEach(
          connectors.filter((connector) => connector.enabled),
          (connector) =>
            Effect.gen(function* () {
              const client = yield* (yield* Connection).client;
              return yield* client["connectors.models"]({
                instanceId: connector.connectorInstanceId,
              });
            }).pipe(
              Effect.orElseSucceed((): ReadonlyArray<ModelOption> => []),
              Effect.map((models): ConnectorModels => ({ connector, models })),
            ),
          { concurrency: "unbounded" },
        );
      }),
    { initialValue: [] as ReadonlyArray<ConnectorModels> },
  );

  return { modelCatalogAtom };
};
