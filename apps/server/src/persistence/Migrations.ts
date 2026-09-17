/**
 * Schema migrations, numbered and run in order.
 *
 * The migration list is a static record: keys are `<id>_<name>` and ids must
 * be contiguous starting at 1 — the lineage test enforces both, because an
 * out-of-order or renumbered migration would corrupt the databases it runs
 * against after release. New migrations append at the next id; existing files
 * are never edited once merged.
 */

import * as Effect from "effect/Effect";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import * as Migrator from "effect/unstable/sql/Migrator";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import m0001 from "./migrations/0001_events";
import m0002 from "./migrations/0002_projections";
import m0003 from "./migrations/0003_settings";

/** The migration record in apply order. `fromRecord` sorts by id. */
export const migrations = {
  "0001_events": m0001,
  "0002_projections": m0002,
  "0003_settings": m0003,
} as const;

export type MigrationKey = keyof typeof migrations;

/** Applies every pending migration, each in its own transaction. */
export const runMigrations: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  MigrationError | SqlError,
  SqlClient.SqlClient
> = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "schema_migrations",
});
