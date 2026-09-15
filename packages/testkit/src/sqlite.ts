/**
 * A throwaway SQLite database for tests.
 *
 * The server's store is `node:sqlite`'s `DatabaseSync` (verified to work under
 * Electron 44, decision log 01), so tests use the same engine rather than a
 * stand-in: a migration that passes here passes in the product. In memory by
 * default, which keeps every test independent without a temp directory to
 * clean up, and `scopedDatabase` closes the handle when the scope ends so a
 * failing test cannot leave one open.
 */

import { DatabaseSync } from "node:sqlite";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** The database could not be opened, or a statement was refused. */
export class SqliteError extends Data.TaggedError("SqliteError")<{
  readonly message: string;
  readonly sql: string | null;
}> {}

/** The location that gives every test its own private database. */
export const IN_MEMORY = ":memory:";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const open = (location: string = IN_MEMORY): Effect.Effect<DatabaseSync, SqliteError> =>
  Effect.try({
    try: () => new DatabaseSync(location),
    catch: (cause) => new SqliteError({ message: messageOf(cause), sql: null }),
  });

/** Closing twice is not an error: teardown runs after a test may already have closed. */
export const close = (database: DatabaseSync): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  });

/** Runs one or more statements for their effect, which is what migrations are. */
export const exec = (database: DatabaseSync, sql: string): Effect.Effect<void, SqliteError> =>
  Effect.try({
    try: () => database.exec(sql),
    catch: (cause) => new SqliteError({ message: messageOf(cause), sql }),
  });

/** An open database for as long as the current scope lives. */
export const scopedDatabase = (
  location: string = IN_MEMORY,
): Effect.Effect<DatabaseSync, SqliteError, Scope.Scope> =>
  Effect.acquireRelease(open(location), close);
