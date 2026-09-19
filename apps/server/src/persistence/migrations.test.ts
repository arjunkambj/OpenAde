import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrations, runMigrations } from "./Migrations";
import { testLayer } from "./Sqlite";

describe("migrations", () => {
  it("are numbered contiguously from 0001", () => {
    const keys = Object.keys(migrations);
    keys.forEach((key, index) => {
      expect(key).toMatch(/^(\d{4,})_[a-z0-9_]+$/);
      const id = Number(key.split("_")[0]);
      expect(id).toBe(index + 1);
    });
  });

  it.effect("apply cleanly and record lineage in schema_migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied = yield* runMigrations;
      expect(applied.length).toBe(Object.keys(migrations).length);

      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM schema_migrations ORDER BY migration_id
      `;
      expect(rows.map((row) => row.migration_id)).toEqual(
        Object.keys(migrations).map((key) => Number(key.split("_")[0])),
      );

      // Core tables exist.
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `;
      const names = tables.map((row) => row.name);
      for (const table of [
        "events",
        "command_receipts",
        "projection_state",
        "projects",
        "threads",
        "settings",
        "permission_rules",
      ]) {
        expect(names).toContain(table);
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("are idempotent: a second run applies nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations;
      const applied = yield* runMigrations;
      expect(applied).toEqual([]);
      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM schema_migrations
      `;
      expect(rows[0]?.n).toBe(Object.keys(migrations).length);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("enforces the per-stream version unique index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations;
      const insert = sql`
        INSERT INTO events (
          event_id, stream_kind, stream_id, stream_version, type,
          occurred_at, actor, payload_json
        ) VALUES (
          ${"e"}, ${"thread"}, ${"t1"}, ${1}, ${"thread.created"},
          ${"2026-01-01T00:00:00.000Z"}, ${"user"}, ${"{}"}
        )
      `;
      yield* insert;
      const duplicate = yield* insert.pipe(
        Effect.map(() => "ok" as const),
        Effect.catch(() => Effect.succeed("conflict" as const)),
      );
      expect(duplicate).toBe("conflict");
    }).pipe(Effect.provide(testLayer())),
  );
});
