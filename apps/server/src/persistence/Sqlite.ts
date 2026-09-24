/**
 * The server's SQL client, backed by `node:sqlite`'s `DatabaseSync`.
 *
 * Electron 44 ships a Node whose embedded SQLite is verified (decision log 01),
 * so the store uses it directly rather than a native module. One `DatabaseSync`
 * underneath, serialised by a semaphore: SQLite is a single-writer engine, and
 * keeping every statement on one connection makes `withTransaction` mean what
 * it says — everything the engine does between BEGIN and COMMIT is atomic.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { databasePath } from "@poseidon/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

type SqliteRow = Record<string, unknown>;

export interface SqliteConfig {
  /** Database location. `:memory:` gives every test its own store. */
  readonly filename: string;
  /** WAL is skipped for in-memory databases, where it cannot apply. */
  readonly disableWAL?: boolean;
}

const toSqlError =
  (operation: string) =>
  (cause: unknown): SqlError =>
    new SqlError({
      reason: classifySqliteError(cause, {
        message: cause instanceof Error ? cause.message : operation,
        operation,
      }),
    });

/** node:sqlite binds no booleans or Dates; normalise the two we produce. */
const normalizeParams = (params: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  params.some((param) => typeof param === "boolean")
    ? params.map((param) => (typeof param === "boolean" ? (param ? 1 : 0) : param))
    : params;

/**
 * Owner-only, for the same reason `writeDevConnectionFile` and the hook
 * tickets are: the database is the whole event log — every prompt, every
 * answer, every tool input and file diff, the settings document and the
 * permission rules — and `mkdir`/`open` under the usual umask left it at
 * 0755/0644, readable by any other account on the machine. The explicit
 * `chmod` matters as much as the mode passed to `mkdir`: neither creating a
 * directory that already exists nor opening a file that already exists lowers
 * what is there, so an install made by an earlier build would have stayed
 * world-readable forever. Best effort — a database on a filesystem with no
 * permission bits at all must still open.
 */
const restrict = (path: string, mode: number): void => {
  try {
    NodeFS.chmodSync(path, mode);
  } catch {
    // Not ours to tighten, or a filesystem without modes. Opening still wins.
  }
};

/** `state.sqlite` and the two files WAL mode keeps beside it. */
const DB_SUFFIXES = ["", "-wal", "-shm"] as const;

const openDatabase = (config: SqliteConfig): Effect.Effect<DatabaseSync, SqlError> =>
  Effect.try({
    try: () => {
      if (config.filename !== ":memory:") {
        const directory = NodePath.dirname(config.filename);
        NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
        restrict(directory, 0o700);
      }
      return new DatabaseSync(config.filename, { enableForeignKeyConstraints: true });
    },
    catch: toSqlError("connect"),
  }).pipe(
    Effect.tap((db) =>
      Effect.try({
        try: () => {
          db.exec("PRAGMA busy_timeout = 5000");
          if (config.filename !== ":memory:") {
            // Before the WAL is switched on: SQLite gives the journal and WAL
            // files the mode of the database file they belong to.
            restrict(config.filename, 0o600);
          }
          if (config.disableWAL !== true && config.filename !== ":memory:") {
            db.exec("PRAGMA journal_mode = WAL");
          }
          if (config.filename !== ":memory:") {
            for (const suffix of DB_SUFFIXES) {
              restrict(`${config.filename}${suffix}`, 0o600);
            }
          }
        },
        catch: toSqlError("configure"),
      }),
    ),
  );

const makeConnection = (config: SqliteConfig): Effect.Effect<Connection, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* openDatabase(config);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          db.close();
        } catch {
          // Closing twice is not an error; teardown runs after tests may close.
        }
      }),
    );

    const cache = new Map<string, StatementSync>();
    const prepare = (sql: string): StatementSync => {
      const cached = cache.get(sql);
      if (cached !== undefined) {
        return cached;
      }
      const statement = db.prepare(sql);
      cache.set(sql, statement);
      return statement;
    };

    const run = (
      sql: string,
      params: ReadonlyArray<unknown> = [],
      prepared = true,
    ): Effect.Effect<ReadonlyArray<SqliteRow>, SqlError> =>
      Effect.withFiber((fiber) => {
        const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers);
        try {
          const statement = prepared ? prepare(sql) : db.prepare(sql);
          statement.setReadBigInts(useSafeIntegers);
          return Effect.succeed(
            statement.all(
              ...(normalizeParams(params) as Array<null | number | bigint | string | Uint8Array>),
            ) as ReadonlyArray<SqliteRow>,
          );
        } catch (cause) {
          return Effect.fail(toSqlError("execute")(cause));
        }
      });

    return {
      execute(sql, params, transformRows) {
        const result = run(sql, params);
        return transformRows ? Effect.map(result, transformRows) : result;
      },
      executeRaw: (sql, params) => run(sql, params),
      executeValues: (sql, params) =>
        Effect.map(run(sql, params), (rows) => rows.map((row) => Object.values(row))),
      executeValuesUnprepared: (sql, params) =>
        Effect.map(run(sql, params, false), (rows) => rows.map((row) => Object.values(row))),
      executeUnprepared(sql, params, transformRows) {
        const result = run(sql, params, false);
        return transformRows ? Effect.map(result, transformRows) : result;
      },
      executeStream(sql, params, transformRows) {
        const result = run(sql, params);
        return Stream.fromIterableEffect(
          transformRows ? Effect.map(result, transformRows) : result,
        );
      },
    } satisfies Connection;
  });

/**
 * Builds a `SqlClient` over one serialised `DatabaseSync`. The transaction
 * acquirer holds the write permit for the scope of the transaction, so nested
 * work joins the outer transaction instead of deadlocking on itself.
 */
/** @public Composition root entry. */
export const makeSqlite = (
  config: SqliteConfig,
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite();
    const semaphore = yield* Semaphore.make(1);
    const connection = yield* makeConnection(config);
    // Scoped, so the permit is held for as long as the statement the connection
    // was handed to runs — `SqlClient` resolves a non-transactional statement's
    // connection through this acquirer and executes inside that scope.
    // `withPermits(1)(Effect.succeed(connection))` released it immediately,
    // which left a gap between the waiting fiber being resumed and its
    // `statement.all(...)` actually running: another fiber could take the freed
    // permit and BEGIN in it, and the waiting statement then executed inside
    // someone else's open transaction — reading its uncommitted writes, or
    // having its own write rolled back with it.
    const acquirer = Effect.acquireRelease(Effect.as(semaphore.take(1), connection), () =>
      semaphore.release(1),
    );
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.as(
        Effect.andThen(
          restore(semaphore.take(1)),
          Effect.tap(Effect.scope, (scope) => Scope.addFinalizer(scope, semaphore.release(1))),
        ),
        connection,
      ),
    );
    return yield* Client.make({
      acquirer,
      compiler,
      transactionAcquirer,
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  });

/**
 * The client and the `Reactivity` service it was built with. Reactivity is an
 * output rather than a private input because it is how a write tells a
 * dependent read to re-run — the settings document re-reads the permission
 * rules that way — and both sides have to mean the same instance.
 *
 * @public
 */
export const layer = (
  config: SqliteConfig,
): Layer.Layer<Client.SqlClient | Reactivity.Reactivity, SqlError> =>
  Layer.unwrap(
    Effect.map(makeSqlite(config), (client) => Layer.succeed(Client.SqlClient, client)),
  ).pipe(Layer.provideMerge(Reactivity.layer));

/** The production location: `~/.poseidon/state.sqlite`. */
/** @public */
export const defaultLayer = (): Layer.Layer<Client.SqlClient | Reactivity.Reactivity, SqlError> =>
  layer({ filename: databasePath() });

/** An in-memory database for tests; closes when the test's scope does. */
export const testLayer = (): Layer.Layer<Client.SqlClient | Reactivity.Reactivity, SqlError> =>
  layer({ filename: ":memory:" });
