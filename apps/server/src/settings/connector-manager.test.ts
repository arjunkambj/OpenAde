/**
 * The W9 reconcile loop, proven against the real `SettingsStore` over sqlite:
 * a fresh install seeds one enabled instance per registered definition,
 * toggles and removals open and close registry entries to match, probes feed
 * `connectors.list`, and a settings row from a previous boot is never
 * re-seeded. Waiting is on the manager's `changes` stream — every assertion
 * follows a reconcile that already landed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeConnectorInstanceId, type ConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import { eraseConnectorDefinition } from "@OpenAde/connector-sdk/definition";
import { makeRegistry, type ConnectorRegistry } from "@OpenAde/connector-sdk/registry";
import { makeFakeConnector } from "@OpenAde/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { runMigrations } from "../persistence/Migrations";
import { layer as sqliteLayer, testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "../rpc/services";
import { ConnectorHost } from "./ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./ConnectorManager";

interface Fixture {
  readonly manager: ConnectorManager["Service"];
  readonly store: SettingsStore["Service"];
  readonly registry: ConnectorRegistry;
  /** How many times the wrapped definition's probe ran. */
  readonly probes: Ref.Ref<number>;
}

/**
 * A manager over one sqlite layer. `makeSqliteLayer` is a parameter so the
 * restart test can point two boots at the same file.
 */
const fixture = (
  makeSqliteLayer: () => Layer.Layer<SqlClient.SqlClient, SqlError.SqlError> = sqliteTestLayer,
) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(makeSqliteLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));

    const fake = yield* makeFakeConnector();
    const probes = yield* Ref.make(0);
    const erased = eraseConnectorDefinition(fake.definition);
    const counting = {
      ...erased,
      probe: (config: unknown) =>
        erased.probe(config).pipe(Effect.tap(() => Ref.update(probes, (n) => n + 1))),
    };
    const registry = yield* makeRegistry([counting]);

    const ctx = yield* Layer.build(
      ConnectorManager.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SettingsStore.layer,
            ConnectorHost.layer,
            Layer.succeed(ConnectorRegistryService, registry),
          ),
        ),
        Layer.provide(sqlite),
      ),
    );
    return {
      manager: Context.get(ctx, ConnectorManager),
      store: Context.get(ctx, SettingsStore),
      registry,
      probes,
    } satisfies Fixture;
  });

const withFixture = <A, E>(
  run: (fixture: Fixture) => Effect.Effect<A, E>,
  makeSqliteLayer?: Parameters<typeof fixture>[0],
) => Effect.scoped(Effect.flatMap(fixture(makeSqliteLayer), run));

/** First summaries matching `pred`, replaying the current value — never a timer. */
const awaitSummaries = (
  manager: ConnectorManager["Service"],
  pred: (summaries: ReadonlyArray<ConnectorSummary>) => boolean,
) =>
  manager.changes.pipe(
    Stream.filter(pred),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("ConnectorManager", () => {
  it.effect("a fresh install seeds one enabled, probed, open instance per definition", () =>
    withFixture(({ manager, registry }) =>
      Effect.gen(function* () {
        const summaries = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "ready",
        );
        const seeded = summaries[0]!;
        expect(seeded.kind).toBe("fake");
        expect(seeded.enabled).toBe(true);
        expect(seeded.capabilities).not.toBeNull();
        expect(seeded.probe.modelCount).toBe(1);
        expect(yield* registry.instances).toHaveLength(1);
      }),
    ),
  );

  it.effect("disabling closes the instance and re-enabling reopens it", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        const conn = (yield* store.get).connectors[0]!;

        yield* store.update({ connectors: [{ ...conn, enabled: false }] });
        const disabled = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.enabled === false,
        );
        // Disabled stays probed — the connectors page still wants binary state.
        expect(disabled[0]!.probe.status).toBe("ready");
        expect(disabled[0]!.capabilities).toBeNull();
        expect(yield* registry.instances).toHaveLength(0);

        yield* store.update({ connectors: [{ ...conn, enabled: true }] });
        yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.capabilities !== null,
        );
        expect(yield* registry.instances).toHaveLength(1);
      }),
    ),
  );

  it.effect("removing the entry deregisters the instance", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        yield* store.update({ connectors: [] });
        yield* awaitSummaries(manager, (all) => all.length === 0);
        expect(yield* registry.instances).toHaveLength(0);
      }),
    ),
  );

  it.effect("list(true) re-probes; models come from the probe", () =>
    withFixture(({ manager, probes }) =>
      Effect.gen(function* () {
        const seeded = yield* awaitSummaries(manager, (all) => all.length === 1);
        const afterReconcile = yield* Ref.get(probes);
        const list = yield* manager.list(true);
        expect(yield* Ref.get(probes)).toBe(afterReconcile + 1);
        expect(list[0]!.probe.status).toBe("ready");
        const models = yield* manager.models(
          seeded[0]!.connectorInstanceId as ConnectorInstanceId,
        );
        expect(models.map((model) => model.id)).toEqual(["fake/model"]);
      }),
    ),
  );

  it.effect("an unknown kind reports an error probe and opens nothing", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* store.update({
          connectors: [
            {
              connectorInstanceId: makeConnectorInstanceId(),
              kind: "no-such-connector",
              displayName: "Ghost",
              enabled: true,
              config: {},
            },
          ],
        });
        const summaries = yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "error",
        );
        expect(summaries[0]!.probe.message).toContain("no-such-connector");
        expect(yield* registry.instances).toHaveLength(0);
      }),
    ),
  );

  it.effect("a settings row from a previous boot is never re-seeded", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "openade-settings-"));
      const fileLayer = () => sqliteLayer({ filename: nodePath.join(dir, "state.sqlite") });

      // Boot 1: seed lands, then the user removes every connector and leaves
      // one disabled entry — a positive signal the next boot's reconcile ran
      // (a disabled instance is still probed) without opening anything.
      const left = {
        connectorInstanceId: makeConnectorInstanceId(),
        kind: "fake",
        displayName: "Leftover",
        enabled: false,
        config: {},
      };
      yield* withFixture(
        ({ manager, store }) =>
          Effect.gen(function* () {
            yield* awaitSummaries(manager, (all) => all.length === 1);
            yield* store.update({ connectors: [] });
            yield* awaitSummaries(manager, (all) => all.length === 0);
            yield* store.update({ connectors: [left] });
            yield* awaitSummaries(manager, (all) => all.length === 1);
          }),
        fileLayer,
      );

      // Boot 2 over the same file: not a fresh install. Reconcile probes the
      // leftover entry; had the seed fired, a second connector would exist.
      yield* withFixture(
        ({ manager, store, registry }) =>
          Effect.gen(function* () {
            const summaries = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "ready",
            );
            expect(summaries[0]!.connectorInstanceId).toBe(left.connectorInstanceId);
            expect(summaries[0]!.enabled).toBe(false);
            expect((yield* store.get).connectors).toHaveLength(1);
            expect(yield* registry.instances).toHaveLength(0);
          }),
        fileLayer,
      );
    }),
  );
});
