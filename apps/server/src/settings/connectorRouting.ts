/**
 * One reading of "which connector a new thread belongs to".
 *
 * Two places need that answer and they must not disagree. `ConnectorSelection`
 * picks the instance a thread's turns run on, and the engine seeds a new
 * thread's model from a connector's `defaultModel` when nothing else supplies
 * one — a seeded model that names a different instance than the one the turn
 * routes to fails on the first request.
 *
 * They used to be two different rules. The engine read the first enabled entry
 * of the settings document; selection took the first instance the registry
 * happened to hold, which is the order `registry.open` was *called* in. The
 * connector manager only reopens entries whose signature changed, so disabling
 * and re-enabling a connector moved it to the end of that order and the two
 * definitions came apart: settings `[A, B]` routed to B and seeded A's model.
 *
 * So both read this instead: the enabled connectors, in the order the settings
 * document lists them — the order the connectors page shows, which is the only
 * one a user can reason about. Straight off the stored row rather than through
 * `SettingsStore`, because the engine's call runs inside its dispatch
 * transaction and the store is not in its layer graph.
 *
 * An enabled entry whose instance failed to open — a bad `binaryPath`, a
 * harness that is installed but dies on `createInstance` — is not in the
 * registry, so selection falls through to the next one that did open. The
 * seed follows it there rather than staying on the document's first entry:
 * with two connectors on different accounts a thread routed to B and seeded
 * with A's model fails its first turn on a model B has never heard of. Which
 * instances are open is `OpenConnectors`, below.
 */

import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** The `settings` table's single row. */
const SETTINGS_KEY = "settings";

/** @public One enabled connector, as the stored settings document has it. */
export interface RoutableConnector {
  readonly connectorInstanceId: ConnectorInstanceId;
  /** What "new threads on this connector" start on, if it was filled in. */
  readonly defaultModel: string | null;
}

/** @public The routing view of the settings document. */
export interface ConnectorRouting {
  /** The app-wide default model, which outranks any connector's own. */
  readonly sharedModel: string | null;
  /** Enabled connectors, in document order. The first is the one to route to. */
  readonly enabled: ReadonlyArray<RoutableConnector>;
}

const EMPTY: ConnectorRouting = { sharedModel: null, enabled: [] };

interface StoredSettings {
  readonly defaults?: { readonly model?: string | null };
  readonly connectors?: ReadonlyArray<{
    readonly connectorInstanceId?: string;
    readonly enabled?: boolean;
    readonly config?: { readonly defaultModel?: string | null };
  }>;
}

/**
 * @public Reads the routing view. A missing or undecodable row answers empty:
 * a settings document nobody can read must not decide where turns go.
 */
export const readConnectorRouting = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ConnectorRouting, SqlError> =>
  Effect.map(
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM settings WHERE key = ${SETTINGS_KEY}
    `,
    (rows) => {
      const row = rows[0];
      if (row === undefined) {
        return EMPTY;
      }
      try {
        const doc = JSON.parse(row.value_json) as StoredSettings;
        return {
          sharedModel: doc.defaults?.model ?? null,
          enabled: (doc.connectors ?? [])
            .filter((connector) => connector.enabled === true)
            .flatMap((connector) =>
              connector.connectorInstanceId === undefined
                ? []
                : [
                    {
                      connectorInstanceId: connector.connectorInstanceId as ConnectorInstanceId,
                      defaultModel: connector.config?.defaultModel ?? null,
                    },
                  ],
            ),
        };
      } catch {
        return EMPTY;
      }
    },
  );

/**
 * @public The instance ids a new thread should be routed to, best first —
 * what `ConnectorSelection` prefers over the registry's own insertion order.
 * A read that fails must not take routing down with it, so it answers empty
 * and the registry's order stands.
 */
export const routingPreference = (
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<ConnectorInstanceId>> =>
  readConnectorRouting(sql).pipe(
    Effect.map((routing) => routing.enabled.map((connector) => connector.connectorInstanceId)),
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<ConnectorInstanceId>)),
  );

/**
 * @public Which instances the registry currently holds open, read fresh each
 * time. A `Context.Reference` because the engine is built long before the
 * registry exists in the layer graph, and because most tests have no registry
 * at all: `null` is "nobody is tracking that", and then the settings document
 * stands alone, which is what those tests already assert.
 */
export const OpenConnectors = Context.Reference<Effect.Effect<
  ReadonlyArray<ConnectorInstanceId>
> | null>("server/settings/OpenConnectors", { defaultValue: () => null });

/**
 * @public The model a `thread.create` without one starts on.
 *
 * The app-wide default outranks everything. Otherwise it is the `defaultModel`
 * of the connector this thread will actually run on — the first enabled entry
 * that is open, which is exactly what `ConnectorSelection` picks. When none of
 * the enabled entries is open, selection falls back to whatever the registry
 * holds and no document entry can speak for it, so nothing is seeded and the
 * thread starts on that connector's own default instead of a foreign model.
 */
export const seedModel = (
  sql: SqlClient.SqlClient,
  open: Effect.Effect<ReadonlyArray<ConnectorInstanceId>> | null,
): Effect.Effect<string | null, SqlError> =>
  Effect.gen(function* () {
    const routing = yield* readConnectorRouting(sql);
    if (routing.sharedModel !== null) {
      return routing.sharedModel;
    }
    if (open === null) {
      return routing.enabled[0]?.defaultModel ?? null;
    }
    const openIds = yield* open;
    return (
      routing.enabled.find((connector) => openIds.includes(connector.connectorInstanceId))
        ?.defaultModel ?? null
    );
  });
