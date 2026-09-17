/**
 * The SQLite-backed settings document: what a fresh install gets, that a
 * stored document is served exactly as written, and what happens to a row this
 * build cannot read at all.
 */

import { DEFAULT_KEYBINDINGS, defaultSettings } from "@OpenAde/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations";
import { PermissionService } from "../permissions/PermissionService";
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
    const ctx = yield* Layer.build(
      Layer.mergeAll(SettingsStore.layer, PermissionService.layer).pipe(Layer.provide(sqlite)),
    );
    return {
      store: Context.get(ctx, SettingsStore),
      // Built over the same SQLite layer on purpose: that is what makes the two
      // share one `Reactivity`, which is how a rule written here reaches there.
      permissions: Context.get(ctx, PermissionService),
      sql,
    };
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

  it.effect("a stored empty keybinding table survives a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The keybindings page can remove every row, so an empty table is a
        // state the user can choose. Seeding defaults back over it would
        // revert that choice on the next start, with nothing to make it stick.
        const { store } = yield* fixture(
          JSON.stringify({ ...defaultSettings(), keybindings: [], theme: "dark" }),
        );
        const settings = yield* store.get;
        expect(settings.keybindings).toEqual([]);
        expect(settings.theme).toBe("dark");
        expect(store.freshInstall).toBe(false);
      }),
    ),
  );

  it.effect("emptying the keybinding table through an update keeps it empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The same choice arrived at from the other direction: a fresh install
        // seeded with the defaults, then emptied. Re-reading has to answer
        // with the empty table, not slide the defaults back in.
        const { store } = yield* fixture();
        const updated = yield* store.update({ keybindings: [] });
        expect(updated.keybindings).toEqual([]);
        expect(yield* store.get).toEqual(updated);
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

  it.effect("a write that fails archives nothing and keeps the raw text pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The archive is what makes overwriting the row safe, so it has to
        // become durable in the same transaction as the overwrite. Ran outside
        // it, a rolled-back save left the copy behind and the store with
        // nothing left to archive on the next attempt.
        const corrupt = JSON.stringify({ theme: "dark", writtenByANewerBuild: true });
        const { store, sql } = yield* fixture(corrupt);

        // A trigger is the only way to make this particular write fail: there
        // is no constraint on the document a caller could violate.
        yield* sql`
          CREATE TRIGGER refuse_settings_write BEFORE UPDATE ON settings
          BEGIN SELECT RAISE(ABORT, 'refused'); END
        `;
        expect(Exit.isFailure(yield* Effect.exit(store.update({ theme: "light" })))).toBe(true);
        expect(yield* rowJson(sql, "settings.unreadable")).toBeNull();
        expect(yield* rowJson(sql, "settings")).toBe(corrupt);

        yield* sql`DROP TRIGGER refuse_settings_write`;
        yield* store.update({ theme: "light" });
        expect(yield* rowJson(sql, "settings.unreadable")).toBe(corrupt);
      }),
    ),
  );

  it.effect("a rule the approval flow appends reaches an open subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // "Allow always" writes to `permission_rules` directly, so the stored
        // document never changes and the settings page saw its list freeze at
        // whatever it loaded with.
        const { store, permissions } = yield* fixture();
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* store.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        // The feed replays the current document, so the first element proves
        // the subscription exists — no timer, and no write into a gap.
        yield* Deferred.await(subscribed);

        yield* permissions.addRule({
          scope: "global",
          pattern: "Shell(git status)",
          decision: "allow",
        });

        const seen = yield* Fiber.join(collected);
        expect(seen[0]!.permissions).toEqual([]);
        expect(seen[1]!.permissions.map((rule) => rule.pattern)).toEqual(["Shell(git status)"]);
      }),
    ),
  );
});
