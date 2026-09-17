/**
 * The SQLite-backed settings document: what a fresh install gets, what happens
 * to a row an older build wrote without keybindings, and what happens to one
 * this build cannot read at all.
 */

import { DEFAULT_KEYBINDINGS, defaultSettings } from "@OpenAde/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "./services";

/** A migrated database, optionally pre-seeded with one raw settings row. */
const rowJson = (sql: SqlClient.SqlClient, key: string) =>
  sql<{ readonly value_json: string }>`
    SELECT value_json FROM settings WHERE key = ${key}
  `.pipe(Effect.map((rows) => rows[0]?.value_json ?? null));

const fixture = (row?: string) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const sql = Context.get(sqliteContext, SqlClient.SqlClient);
    if (row !== undefined) {
      yield* sql`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES ('settings', ${row}, '2026-01-01T00:00:00.000Z')
      `;
    }
    const ctx = yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite)));
    return { store: Context.get(ctx, SettingsStore), sql };
  });

describe("SettingsStore", () => {
  it.effect("a fresh install gets the contracts' default keybindings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* fixture();
        const settings = yield* store.get;
        expect(settings.keybindings.length).toBe(DEFAULT_KEYBINDINGS.length);
        expect(settings.keybindings.map((k) => k.command)).toEqual(
          DEFAULT_KEYBINDINGS.map((k) => k.command),
        );
        expect(store.freshInstall).toBe(true);
      }),
    ),
  );

  it.effect("a row written with an empty keybinding table is healed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // What the build with the server's own defaults wrote: a valid
        // document whose keybinding table disables every shortcut.
        const { store } = yield* fixture(
          JSON.stringify({ ...defaultSettings(), keybindings: [], theme: "dark" }),
        );
        const settings = yield* store.get;
        expect(settings.keybindings.length).toBe(DEFAULT_KEYBINDINGS.length);
        // Healing the table must not touch anything the user did choose.
        expect(settings.theme).toBe("dark");
        expect(store.freshInstall).toBe(false);
      }),
    ),
  );

  it.effect("an undecodable row is archived before the first write replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // One field from a newer build is enough. The store cannot serve this
        // document, but overwriting it would destroy the connector instances
        // and permission rules a downgrade would otherwise still find.
        const corrupt = JSON.stringify({ theme: "dark", writtenByANewerBuild: true });
        const { store, sql } = yield* fixture(corrupt);
        yield* store.update({ theme: "light" });

        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
        const settings = yield* store.get;
        expect(settings.theme).toBe("light");

        // A second save must not overwrite the archive with a readable row.
        yield* store.update({ theme: "dark" });
        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
      }),
    ),
  );
});
