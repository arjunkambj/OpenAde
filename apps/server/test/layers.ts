/**
 * Shared test wiring for the server suite.
 *
 * Everything composes the in-memory SQLite layer with the real persistence,
 * engine and reactor code — the fakes only enter through the connector
 * instance the caller passes in, so the tests exercise the same layers the
 * production composition will.
 */

import type { ConnectorInstance } from "@OpenAde/connector-sdk/definition";
import * as Layer from "effect/Layer";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { OrchestrationEngine } from "../src/orchestration/Engine";
import { CheckpointHook, CheckpointReactor } from "../src/orchestration/CheckpointReactor";
import { ProviderCommandReactor } from "../src/orchestration/ProviderCommandReactor";
import { ConnectorSelection, SessionManager } from "../src/orchestration/SessionManager";
import {
  makeSessionSupervisor,
  type SupervisorOptions,
} from "../src/orchestration/SessionSupervisor";
import { EventStore } from "../src/persistence/EventStore";
import { ReadModelStore } from "../src/persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../src/persistence/Sqlite";

/** In-memory SQLite plus the stores that sit on it. */
export const persistenceLayer = (): Layer.Layer<
  import("effect/unstable/sql/SqlClient").SqlClient | EventStore | ReadModelStore,
  SqlError
> => {
  const sqlite = sqliteTestLayer();
  return Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
};

/** The migrated engine over in-memory persistence. */
export const engineLayer = (): Layer.Layer<OrchestrationEngine, SqlError | MigrationError> =>
  OrchestrationEngine.layer.pipe(Layer.provide(persistenceLayer()));

export interface StackOptions {
  /** The connector every thread runs on — tests pass a `FakeConnector` instance. */
  readonly instance: ConnectorInstance;
  /** `false` skips the supervisor; otherwise its options (defaults: no backoff sleep). */
  readonly supervisor?: SupervisorOptions | false;
}

/**
 * Engine + session manager + every reactor, all real — only the connector is
 * the caller's fake.
 */
export const stackLayer = (
  options: StackOptions,
): Layer.Layer<OrchestrationEngine | SessionManager, SqlError | MigrationError> => {
  const engine = engineLayer();
  const selection = ConnectorSelection.fromInstance(options.instance);
  const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
  const reactors = Layer.mergeAll(
    ProviderCommandReactor,
    CheckpointReactor,
    options.supervisor === false
      ? Layer.empty
      : makeSessionSupervisor(options.supervisor ?? { baseDelayMillis: 0 }),
  ).pipe(Layer.provide(Layer.mergeAll(engine, manager, CheckpointHook.noop)));
  return Layer.mergeAll(engine, manager, reactors);
};
