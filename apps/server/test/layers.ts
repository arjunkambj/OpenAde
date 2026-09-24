/**
 * Shared test wiring for the server suite.
 *
 * Everything composes the in-memory SQLite layer with the real persistence,
 * engine and reactor code — the fakes only enter through the connector
 * instance the caller passes in, so the tests exercise the same layers the
 * production composition will.
 */

import type { ConnectorInstance } from "@poseidon/connector-sdk/definition";
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
import { layer as sqliteFileLayer, testLayer as sqliteTestLayer } from "../src/persistence/Sqlite";

/**
 * `Reactivity` is one of the outputs because the SQLite layer builds it: a
 * write tells a dependent read to re-run through it (the settings document
 * re-reads the permission rules that way), so everything on one database has to
 * see the one instance.
 */
export type PersistenceLayer = Layer.Layer<
  | import("effect/unstable/sql/SqlClient").SqlClient
  | import("effect/unstable/reactivity/Reactivity").Reactivity
  | EventStore
  | ReadModelStore,
  SqlError | MigrationError
>;

/**
 * SQLite plus the stores that sit on it. In-memory by default; pass a path to
 * get a real file, which is the only way to build a second engine over a
 * database a first one already wrote — the cold-boot resume path.
 */
export const persistenceLayer = (filename = ":memory:"): PersistenceLayer => {
  const sqlite = filename === ":memory:" ? sqliteTestLayer() : sqliteFileLayer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
};

/** The migrated engine over in-memory persistence. */
export const engineLayer = (
  persistence: PersistenceLayer = persistenceLayer(),
): Layer.Layer<OrchestrationEngine, SqlError | MigrationError> =>
  OrchestrationEngine.layer.pipe(Layer.provide(persistence));

export interface StackOptions {
  /** The connector every thread runs on — tests pass a `FakeConnector` instance. */
  readonly instance: ConnectorInstance;
  /** `false` skips the supervisor; otherwise its options (defaults: no backoff sleep). */
  readonly supervisor?: SupervisorOptions | false;
  /**
   * `false` leaves the checkpoint reactor out — for a test that appends a
   * `thread.checkpoint.restore.requested` itself, to put a thread in the
   * `restoring` state, and does not want git work racing it.
   */
  readonly checkpoints?: boolean;
  /** Where the log lives. Defaults to a fresh in-memory database. */
  readonly persistence?: PersistenceLayer;
}

/**
 * Engine + session manager + every reactor, all real — only the connector is
 * the caller's fake.
 */
export const stackLayer = (
  options: StackOptions,
): Layer.Layer<OrchestrationEngine | SessionManager, SqlError | MigrationError> => {
  // One persistence layer shared by the engine and the reactors — the
  // CheckpointReactor reads the event log directly, so a second in-memory
  // database would leave it blind.
  const persistence = options.persistence ?? persistenceLayer();
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const selection = ConnectorSelection.fromInstance(options.instance);
  const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));
  const reactors = Layer.mergeAll(
    ProviderCommandReactor,
    options.checkpoints === false ? Layer.empty : CheckpointReactor,
    options.supervisor === false
      ? Layer.empty
      : makeSessionSupervisor(options.supervisor ?? { baseDelayMillis: 0 }),
  ).pipe(Layer.provide(Layer.mergeAll(engine, manager, CheckpointHook.noop, persistence)));
  return Layer.mergeAll(engine, manager, reactors);
};
