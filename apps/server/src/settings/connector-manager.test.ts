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
import {
  makeConnectorInstanceId,
  makeThreadId,
  type ConnectorInstanceId,
} from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import type { AnyConnectorDefinition, ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { eraseConnectorDefinition, ProbeFailed } from "@OpenAde/connector-sdk/definition";
import { makeRegistry, type ConnectorRegistry } from "@OpenAde/connector-sdk/registry";
import { makeFakeConnector } from "@OpenAde/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClientTag from "effect/unstable/sql/SqlClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { ConnectorSelection } from "../orchestration/SessionManager";
import type { ThreadDoc } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { layer as sqliteLayer, testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { SettingsStore } from "../rpc/services";
import { ConnectorHost } from "./ConnectorHost";
import { ConnectorManager, ConnectorRegistryService } from "./ConnectorManager";
import { readConnectorRouting, routingPreference } from "./connectorRouting";

interface Fixture {
  readonly manager: ConnectorManager["Service"];
  readonly store: SettingsStore["Service"];
  readonly registry: ConnectorRegistry;
  /** How many times the wrapped definition's probe ran. */
  readonly probes: Ref.Ref<number>;
  /** The façade every instance is opened against; the entrypoint fills it in. */
  readonly host: ConnectorHost["Service"];
  /** The same connection the store writes through — what routing reads. */
  readonly sql: SqlClient.SqlClient;
}

/**
 * A manager over one sqlite layer. `makeSqliteLayer` is a parameter so the
 * restart test can point two boots at the same file.
 */
const fixture = (
  makeSqliteLayer: () => Layer.Layer<
    SqlClient.SqlClient | Reactivity.Reactivity,
    SqlError.SqlError
  > = sqliteTestLayer,
  /** Lets a test swap in a definition whose probe misbehaves. */
  wrap: (definition: AnyConnectorDefinition) => AnyConnectorDefinition = (definition) => definition,
) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(makeSqliteLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));

    const fake = yield* makeFakeConnector();
    const probes = yield* Ref.make(0);
    const erased = eraseConnectorDefinition(fake.definition);
    const counting = wrap({
      ...erased,
      probe: (config: unknown) =>
        erased.probe(config).pipe(Effect.tap(() => Ref.update(probes, (n) => n + 1))),
    });
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
      host: Context.get(ctx, ConnectorHost),
      sql: Context.get(sqliteContext, SqlClientTag.SqlClient),
    } satisfies Fixture;
  });

const withFixture = <A, E>(
  run: (fixture: Fixture) => Effect.Effect<A, E>,
  makeSqliteLayer?: Parameters<typeof fixture>[0],
  wrap?: Parameters<typeof fixture>[1],
) => Effect.scoped(Effect.flatMap(fixture(makeSqliteLayer, wrap), run));

/** First summaries matching `pred`, replaying the current value — never a timer. */
const awaitSummaries = (
  manager: ConnectorManager["Service"],
  pred: (summaries: ReadonlyArray<ConnectorSummary>) => boolean,
) => manager.changes.pipe(Stream.filter(pred), Stream.runHead, Effect.map(Option.getOrThrow));

const threadId = makeThreadId();

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

  it.effect("`ready` waits for the open instance, not for its probe", () =>
    Effect.gen(function* () {
      // The entrypoint writes the handshake once `ready` completes. A probe can
      // burn its full timeout, so what must be true by then is registration:
      // `ConnectorSelection` answers `NoConnector` off an empty registry.
      const release = yield* Deferred.make<void>();
      yield* withFixture(
        ({ manager, registry }) =>
          Effect.gen(function* () {
            yield* manager.ready;
            expect(yield* registry.instances).toHaveLength(1);
            // Still inside the first probe: the summary has nothing to report.
            const pending = yield* manager.list();
            expect(pending[0]!.probe.status).toBe("probing");

            yield* Deferred.succeed(release, undefined);
            const probed = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "ready",
            );
            expect(probed[0]!.probe.modelCount).toBe(1);
          }),
        undefined,
        (definition) => ({
          ...definition,
          probe: (config: unknown) =>
            Effect.andThen(Deferred.await(release), definition.probe(config)),
        }),
      );
    }),
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
        yield* awaitSummaries(manager, (all) => all.length === 1 && all[0]!.capabilities !== null);
        expect(yield* registry.instances).toHaveLength(1);
      }),
    ),
  );

  it.effect("an instance re-enabled after boot is lent the running app's endpoints", () =>
    Effect.gen(function* () {
      /** What `registry.open` handed the connector, per open. */
      const lent: Array<ConnectorServices> = [];
      const record = (definition: AnyConnectorDefinition): AnyConnectorDefinition => ({
        ...definition,
        createInstance: (input) => {
          lent.push(input.services);
          return definition.createInstance(input);
        },
      });

      yield* withFixture(
        ({ manager, store, registry, host }) =>
          Effect.gen(function* () {
            yield* awaitSummaries(manager, (all) => all.length === 1);
            const conn = (yield* store.get).connectors[0]!;

            // The order production runs in: the manager opens instances while
            // the graph is built, and only the booted app can say where its
            // gateway and hook bridge listen.
            yield* host.install({
              mcpEndpoint: (id) => Effect.succeed({ url: `http://mcp/${id}`, bearer: "mcp" }),
              hookEndpoint: (id) => Effect.succeed({ url: `http://hooks/${id}`, bearer: "hook" }),
              permissions: { decide: () => Effect.succeed("allow" as const) },
            });

            yield* store.update({ connectors: [{ ...conn, enabled: false }] });
            yield* awaitSummaries(manager, (all) => all[0]!.enabled === false);
            yield* store.update({ connectors: [{ ...conn, enabled: true }] });
            yield* awaitSummaries(manager, (all) => all[0]!.capabilities !== null);

            // One live instance, and the object it was opened against answers
            // with the installed endpoints rather than dying on first use —
            // which is what a second, placeholder-backed open used to leave
            // behind for whichever copy routing happened to pick.
            expect(yield* registry.instances).toHaveLength(1);
            const services = lent.at(-1)!;
            expect((yield* services.hookEndpoint(threadId)).url).toBe(`http://hooks/${threadId}`);
            expect((yield* services.mcpEndpoint(threadId)).url).toBe(`http://mcp/${threadId}`);
          }),
        undefined,
        record,
      );
    }),
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
        const models = yield* manager.models(seeded[0]!.connectorInstanceId as ConnectorInstanceId);
        expect(models.map((model) => model.id)).toEqual(["fake/model"]);
      }),
    ),
  );

  it.effect("models fall back to the open instance when the probe failed", () =>
    withFixture(
      ({ manager }) =>
        Effect.gen(function* () {
          const summaries = yield* awaitSummaries(
            manager,
            (all) => all.length === 1 && all[0]!.probe.status === "error",
          );
          const instanceId = summaries[0]!.connectorInstanceId as ConnectorInstanceId;
          // The instance opened fine; only its probe is broken, so the model
          // pickers must still be filled from `listModels()`.
          const models = yield* manager.models(instanceId);
          expect(models.map((model) => model.id)).toEqual(["fake/model"]);
        }),
      undefined,
      (definition) => ({
        ...definition,
        probe: () => Effect.fail(new ProbeFailed({ kind: definition.kind, message: "no binary" })),
      }),
    ),
  );

  it.effect("a refresh straight after a write answers from the reconciled document", () =>
    withFixture(({ manager, store, registry }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(
          manager,
          (all) => all.length === 1 && all[0]!.probe.status === "ready",
        );
        const existing = (yield* store.get).connectors[0]!;
        const added = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Second",
          enabled: true,
          config: {},
        };
        yield* store.update({ connectors: [existing, added] });

        // What the connectors panel does the moment a save lands. The refresh
        // and the reconcile the write woke both want the reconcile mutex, so
        // the refresh reconciles the document itself: whichever gets there
        // first, the panel is handed an opened, probed instance.
        const listed = yield* manager.list(true);
        const fresh = listed.find(
          (summary) => summary.connectorInstanceId === added.connectorInstanceId,
        )!;
        expect(fresh.probe.status).toBe("ready");
        expect(fresh.capabilities).not.toBeNull();
        expect(yield* registry.instances).toHaveLength(2);
      }),
    ),
  );

  it.effect("the model fallback is asked once, and again after the next probe", () =>
    Effect.gen(function* () {
      // `listModels()` is a re-probe for a real connector — two child processes
      // for the cmd one — and every model picker asks on mount, so the answer
      // has to be held until something replaces it.
      const listed = yield* Ref.make(0);
      yield* withFixture(
        ({ manager }) =>
          Effect.gen(function* () {
            const summaries = yield* awaitSummaries(
              manager,
              (all) => all.length === 1 && all[0]!.probe.status === "error",
            );
            const instanceId = summaries[0]!.connectorInstanceId as ConnectorInstanceId;
            yield* manager.models(instanceId);
            yield* manager.models(instanceId);
            expect(yield* Ref.get(listed)).toBe(1);

            // A fresh probe retires the memo — a connector that got its binary
            // back must not keep answering from the empty list.
            yield* manager.list(true);
            yield* manager.models(instanceId);
            expect(yield* Ref.get(listed)).toBe(2);
          }),
        undefined,
        (definition) => ({
          ...definition,
          probe: () =>
            Effect.fail(new ProbeFailed({ kind: definition.kind, message: "no binary" })),
          createInstance: (input) =>
            Effect.map(definition.createInstance(input), (instance) => ({
              ...instance,
              listModels: () =>
                Effect.andThen(
                  Ref.update(listed, (count) => count + 1),
                  instance.listModels(),
                ),
            })),
        }),
      );
    }),
  );

  it.effect("routes to the connector the document lists first, however it was opened", () =>
    withFixture(({ manager, store, registry, sql }) =>
      Effect.gen(function* () {
        yield* awaitSummaries(manager, (all) => all.length === 1);
        const first = {
          ...(yield* store.get).connectors[0]!,
          config: { defaultModel: "acme/first" },
        };
        const second = {
          connectorInstanceId: makeConnectorInstanceId(),
          kind: "fake",
          displayName: "Second",
          enabled: true,
          config: { defaultModel: "acme/second" },
        };
        const bothOpen = (all: ReadonlyArray<ConnectorSummary>) =>
          all.length === 2 && all.every((summary) => summary.capabilities !== null);

        yield* store.update({ connectors: [first, second] });
        yield* awaitSummaries(manager, bothOpen);

        // Disabling and re-enabling the *first* entry is all it takes: only a
        // changed signature is reopened, so it goes to the back of the
        // registry's insertion order while the document still lists it first.
        yield* store.update({ connectors: [{ ...first, enabled: false }, second] });
        yield* awaitSummaries(manager, (all) => all[0]!.capabilities === null);
        yield* store.update({ connectors: [first, second] });
        yield* awaitSummaries(manager, bothOpen);

        const instances = yield* registry.instances;
        expect(instances.map((instance) => instance.instanceId)).toEqual([
          second.connectorInstanceId,
          first.connectorInstanceId,
        ]);

        // `fromRegistry` holds no resources of its own, so a scope just for
        // the lookup is enough.
        const selection = yield* Effect.scoped(
          Effect.map(
            Layer.build(ConnectorSelection.fromRegistry(registry, routingPreference(sql))),
            (built) => Context.get(built, ConnectorSelection),
          ),
        );
        const routed = yield* selection.instanceFor({ threadId } as ThreadDoc);
        expect(routed.instanceId).toBe(first.connectorInstanceId);

        // And the model a new thread is seeded with is that same instance's —
        // the engine reads this, so a thread can never start on a model its
        // connector was never asked about.
        const routing = yield* readConnectorRouting(sql);
        expect(routing.enabled[0]!.connectorInstanceId).toBe(routed.instanceId);
        expect(routing.enabled[0]!.defaultModel).toBe("acme/first");
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
