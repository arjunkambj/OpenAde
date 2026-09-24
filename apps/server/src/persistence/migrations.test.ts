import { LEGACY_DEFAULT_KEYBINDINGS } from "@OpenAde/contracts/keybindings";
import { Settings, defaultSettings } from "@OpenAde/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
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

describe("0006_terminal_keybinding", () => {
  const TOGGLE = { command: "terminal.toggle", shortcut: "Cmd+J" };

  /** Every migration before 0006, so a row can be stored the way an older build left it. */
  const upTo0005 = Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        Object.entries(migrations).filter(([key]) => Number(key.split("_")[0]) < 6),
      ),
    ),
    table: "schema_migrations",
  });

  /** Stores `row` (or nothing) as the settings document, runs 0006 and returns the document after. */
  const migrate = (row: string | null) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* upTo0005;
      if (row !== null) {
        yield* sql`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES ('settings', ${row}, '2026-01-01T00:00:00.000Z')
        `;
      }
      const applied = yield* runMigrations;
      expect(applied.map(([id]) => id)).toContain(6);
      const rows = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM settings WHERE key = 'settings'
      `;
      return rows[0]?.value_json ?? null;
    }).pipe(Effect.provide(testLayer()));

  const stored = (keybindings: unknown) =>
    JSON.stringify({ theme: "dark", keybindings, permissions: [] });

  it.effect("appends the toggle to a table saved before the terminal existed", () =>
    Effect.gen(function* () {
      const before = [
        { command: "thread.new", shortcut: "Cmd+N" },
        { command: "browserPane.toggle", shortcut: "Cmd+Shift+B", when: "browserPaneAvailable" },
      ];
      const after = yield* migrate(stored(before));
      expect(JSON.parse(after!)).toEqual({
        theme: "dark",
        keybindings: [...before, TOGGLE],
        permissions: [],
      });
    }),
  );

  it.effect("brings a stored default table up to that build's defaults", () =>
    Effect.gen(function* () {
      const { keybindingsFormat: _format, ...legacy } = defaultSettings();
      const older = {
        ...legacy,
        keybindings: LEGACY_DEFAULT_KEYBINDINGS.filter(
          (binding) => binding.command !== TOGGLE.command,
        ),
      };
      const after = yield* migrate(JSON.stringify(older));
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(after);
      expect(decoded.keybindings).toEqual(LEGACY_DEFAULT_KEYBINDINGS);
    }),
  );

  it.effect("leaves a table alone when Cmd+J already does something else", () =>
    Effect.gen(function* () {
      for (const shortcut of ["Cmd+J", " cmd + j ", "Mod+J"]) {
        const row = stored([{ command: "thread.new", shortcut }]);
        expect(yield* migrate(row)).toBe(row);
      }
    }),
  );

  it.effect("leaves a table alone when it already binds the toggle", () =>
    Effect.gen(function* () {
      const row = stored([{ command: "terminal.toggle", shortcut: "Cmd+Shift+T" }]);
      expect(yield* migrate(row)).toBe(row);
    }),
  );

  it.effect("leaves an empty table to the renderer's defaults", () =>
    Effect.gen(function* () {
      const row = stored([]);
      expect(yield* migrate(row)).toBe(row);
    }),
  );

  it.effect("writes nothing on a fresh install", () =>
    Effect.gen(function* () {
      expect(yield* migrate(null)).toBeNull();
    }),
  );

  it.effect("leaves a row it cannot parse to the unreadable-row path", () =>
    Effect.gen(function* () {
      for (const row of ["{not json", "[]", JSON.stringify({ theme: "dark" })]) {
        expect(yield* migrate(row)).toBe(row);
      }
    }),
  );
});

describe("0007_dock_keys_new_task", () => {
  const WIDE = "threadOpen || newTaskOpen";

  /** Every migration before 0007. */
  const upTo0006 = Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        Object.entries(migrations).filter(([key]) => Number(key.split("_")[0]) < 7),
      ),
    ),
    table: "schema_migrations",
  });

  /** Stores `row` (or nothing) as the settings document, runs 0007 and returns the document after. */
  const migrate = (row: string | null) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* upTo0006;
      if (row !== null) {
        yield* sql`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES ('settings', ${row}, '2026-01-01T00:00:00.000Z')
        `;
      }
      const applied = yield* runMigrations;
      expect(applied.map(([id]) => id)).toEqual([7]);
      const rows = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM settings WHERE key = 'settings'
      `;
      return rows[0]?.value_json ?? null;
    }).pipe(Effect.provide(testLayer()));

  const stored = (keybindings: unknown) =>
    JSON.stringify({ theme: "dark", keybindings, permissions: [], keybindingsFormat: "overrides" });

  it.effect("widens a dock key saved with the old threadOpen clause", () =>
    Effect.gen(function* () {
      const after = yield* migrate(
        stored([
          { command: "dock.toggle", shortcut: "Mod+Alt+D", when: "threadOpen" },
          { command: "dock.changes", shortcut: "Mod+Shift+C", when: "threadOpen" },
          { command: "dock.files", shortcut: "Mod+O", when: "threadOpen" },
        ]),
      );
      expect(JSON.parse(after!).keybindings).toEqual([
        { command: "dock.toggle", shortcut: "Mod+Alt+D", when: WIDE },
        { command: "dock.changes", shortcut: "Mod+Shift+C", when: WIDE },
        { command: "dock.files", shortcut: "Mod+O", when: WIDE },
      ]);
    }),
  );

  it.effect("keeps everything else as it was, in order", () =>
    Effect.gen(function* () {
      const before = [
        { command: "thread.rename", shortcut: "Mod+Alt+R", when: "threadOpen" },
        { command: "dock.toggle", shortcut: "Mod+Alt+B", when: "threadOpen" },
        { command: "dock.files", shortcut: "Mod+P", when: "threadOpen && !inputFocus" },
        { command: "dock.changes", shortcut: "Mod+Shift+D" },
        { command: "-dock.files", shortcut: "Mod+P" },
      ];
      const after = yield* migrate(stored(before));
      expect(JSON.parse(after!).keybindings).toEqual([
        before[0],
        { command: "dock.toggle", shortcut: "Mod+Alt+B", when: WIDE },
        before[2],
        before[3],
        before[4],
      ]);
    }),
  );

  it.effect("writes nothing when no dock key has the old clause", () =>
    Effect.gen(function* () {
      const row = stored([{ command: "dock.toggle", shortcut: "Mod+Alt+B", when: WIDE }]);
      expect(yield* migrate(row)).toBe(row);
      expect(yield* migrate(null)).toBeNull();
    }),
  );

  it.effect("leaves a row it cannot parse to the unreadable-row path", () =>
    Effect.gen(function* () {
      for (const row of ["{not json", "[]", JSON.stringify({ theme: "dark" })]) {
        expect(yield* migrate(row)).toBe(row);
      }
    }),
  );
});
