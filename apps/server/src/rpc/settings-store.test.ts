import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_KEYBINDINGS } from "@OpenAde/contracts/settings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "./services";

/** A `SettingsStore` over a migrated in-memory database. */
const fixture = Effect.gen(function* () {
  const sqliteContext = yield* Layer.build(sqliteTestLayer());
  const sqlite = Layer.succeedContext(sqliteContext);
  yield* runMigrations.pipe(Effect.provide(sqlite));
  const context = yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite)));
  return Context.get(context, SettingsStore);
});

const withStore = <A, E>(run: (store: SettingsStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(fixture, run));

describe("SettingsStore", () => {
  it.effect("serves the contract's keybindings on a fresh install", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const settings = yield* store.get;
        expect(store.freshInstall).toBe(true);
        expect(settings.keybindings).toEqual(DEFAULT_KEYBINDINGS);
      }),
    ),
  );

  // "No shortcuts" has to be reachable: a client that substitutes the defaults
  // for an empty served table makes "remove every binding" unachievable.
  it.effect("keeps an emptied keybinding table empty", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const updated = yield* store.update({ keybindings: [] });
        expect(updated.keybindings).toEqual([]);
        expect(yield* store.get).toEqual(updated);
      }),
    ),
  );
});
