import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { close, exec, open, scopedDatabase } from "./sqlite";

describe("in-memory sqlite", () => {
  it.effect("runs DDL and reads rows back", () =>
    Effect.gen(function* () {
      const database = yield* open();
      yield* exec(
        database,
        `CREATE TABLE events (sequence INTEGER PRIMARY KEY, stream_id TEXT NOT NULL);
         INSERT INTO events (sequence, stream_id) VALUES (1, 'thread-1'), (2, 'thread-2');`,
      );

      const rows = yield* Effect.sync(() =>
        database.prepare("SELECT stream_id FROM events ORDER BY sequence").all(),
      );
      expect(rows).toEqual([{ stream_id: "thread-1" }, { stream_id: "thread-2" }]);

      yield* close(database);
    }),
  );

  it.effect("reports a refused statement as a SqliteError carrying the sql", () =>
    Effect.gen(function* () {
      const database = yield* open();
      const error = yield* exec(database, "SELECT * FROM nothing_like_this").pipe(Effect.flip);

      expect(error._tag).toBe("SqliteError");
      expect(error.sql).toBe("SELECT * FROM nothing_like_this");

      yield* close(database);
    }),
  );

  it.effect("gives every caller its own database", () =>
    Effect.gen(function* () {
      const first = yield* open();
      const second = yield* open();
      yield* exec(first, "CREATE TABLE only_here (id INTEGER)");

      const error = yield* exec(second, "SELECT * FROM only_here").pipe(Effect.flip);
      expect(error._tag).toBe("SqliteError");

      yield* close(first);
      yield* close(second);
    }),
  );

  it.effect("closes the handle when the scope ends", () =>
    Effect.gen(function* () {
      const database = yield* Effect.scoped(
        Effect.gen(function* () {
          const scoped = yield* scopedDatabase();
          yield* exec(scoped, "CREATE TABLE t (id INTEGER)");
          return scoped;
        }),
      );

      // Using a closed handle throws, which is how we know the scope closed it.
      expect(() => database.exec("SELECT 1")).toThrow();
    }),
  );
});
