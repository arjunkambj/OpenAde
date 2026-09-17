/**
 * Reconciles `settings.connectors` against the connector registry.
 *
 * The settings document is the desired state; the registry's open instances
 * are the actual state. This service subscribes to `SettingsStore.changes` and
 * closes that gap: a new or edited entry is probed (always — the connectors
 * page wants binary state even for a disabled instance) and opened (when
 * enabled), a toggled one is closed or reopened, and a removed one's scope is
 * closed, which deregisters it. `ConnectorSelection` reads the live registry,
 * so routing follows the reconcile without touching the session layer.
 *
 * On a fresh install — no settings row ever existed — each registered
 * definition is seeded as one enabled instance, so the app works out of the
 * box. A user who later removes every connector has a settings row by then,
 * so the seed never resurrects deleted instances.
 *
 * `connectors.list` answers from the last reconcile's probes; `refresh: true`
 * re-runs every probe first, which is what the settings page's probe button
 * triggers.
 */

import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import { makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary, ModelOption } from "@OpenAde/contracts/rpc";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";
import type { ConnectorProbe } from "@OpenAde/connector-sdk/definition";
import { toWireProbe } from "@OpenAde/connector-sdk/definition";
import type { ConnectorRegistry } from "@OpenAde/connector-sdk/registry";
import type { ConnectorInstanceConfig, Settings } from "@OpenAde/contracts/settings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ConnectorCatalog, SettingsStore } from "../rpc/services";
import { ConnectorHost } from "./ConnectorHost";

/** The registry as a service so tests and `main.ts` inject the same instance. */
export class ConnectorRegistryService extends Context.Service<
  ConnectorRegistryService,
  ConnectorRegistry
>()("server/settings/ConnectorRegistryService") {}

/** A probe that could not run: no definition, a ProbeFailed, or the timeout. */
const failedProbe = (message: string, probedAt: string): ConnectorProbe => ({
  status: "error",
  message,
  probedAt,
  auth: "unknown",
  models: [],
  warnings: [],
});

/** The wire stand-in for an entry whose first probe has not landed yet. */
const probingProbe = (probedAt: string) => ({ status: "probing" as const, probedAt });

interface Entry {
  readonly signature: string;
  readonly scope: Scope.Closeable | null;
}

/** A probe gets this long before it's reported as an error. */
const PROBE_TIMEOUT = Duration.seconds(15);

export class ConnectorManager extends Context.Service<
  ConnectorManager,
  {
    readonly list: (refresh?: boolean) => Effect.Effect<ReadonlyArray<ConnectorSummary>>;
    readonly models: (
      instanceId: ConnectorInstanceId,
    ) => Effect.Effect<ReadonlyArray<ModelOption>>;
    /** Emits the summary list after every reconcile — tests and a future subscribe RPC. */
    readonly changes: Stream.Stream<ReadonlyArray<ConnectorSummary>>;
  }
>()("server/settings/ConnectorManager") {
  static readonly layer = Layer.effect(
    ConnectorManager,
    Effect.gen(function* () {
      const store = yield* SettingsStore;
      const host = yield* ConnectorHost;
      const registry = yield* ConnectorRegistryService;

      const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map());
      const probes = yield* Ref.make<ReadonlyMap<string, ConnectorProbe>>(new Map());
      const capabilities = yield* Ref.make<ReadonlyMap<string, ConnectorCapabilities>>(
        new Map(),
      );
      /** Latest summary list — replays to new subscribers, so none miss a reconcile. */
      const summariesRef = yield* SubscriptionRef.make<ReadonlyArray<ConnectorSummary>>([]);
      /** Serialises reconcile passes and explicit re-probes. */
      const mutex = yield* Semaphore.make(1);
      const seeded = yield* Ref.make(false);

      const now = Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (ms) =>
        new Date(ms).toISOString(),
      );

      /** One probe of one configured entry; never fails — failures are data. */
      const probeOf = (conn: ConnectorInstanceConfig): Effect.Effect<ConnectorProbe> =>
        Effect.gen(function* () {
          const probedAt = yield* now;
          const definition = yield* registry.definitionFor(conn.kind).pipe(Effect.option);
          if (Option.isNone(definition)) {
            return failedProbe(
              `this build has no connector for kind "${conn.kind}"`,
              probedAt,
            );
          }
          const outcome = yield* definition.value.probe(conn.config).pipe(
            Effect.timeoutOption(PROBE_TIMEOUT),
            Effect.exit,
          );
          if (Exit.isFailure(outcome)) {
            return failedProbe(Cause.pretty(outcome.cause), probedAt);
          }
          return Option.getOrElse(outcome.value, () =>
            failedProbe("probe timed out", probedAt),
          );
        });

      const openInstance = (conn: ConnectorInstanceConfig): Effect.Effect<Entry["scope"]> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const opened = yield* registry
            .open({
              instanceId: conn.connectorInstanceId,
              kind: conn.kind,
              config: conn.config,
              services: host.services,
            })
            .pipe(Scope.provide(scope), Effect.exit);
          if (Exit.isFailure(opened)) {
            // The probe already reported what it found; a failed open leaves
            // the instance unregistered, which is the honest state.
            yield* Effect.logWarning(
              `connector instance ${conn.connectorInstanceId} failed to open: ${Cause.pretty(opened.cause)}`,
            );
            yield* Scope.close(scope, Exit.void);
            return null;
          }
          yield* Ref.update(capabilities, (all) =>
            new Map(all).set(conn.connectorInstanceId, opened.value.capabilities),
          );
          return scope;
        });

      const closeEntry = (id: string, entry: Entry): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (entry.scope !== null) {
            yield* Scope.close(entry.scope, Exit.void);
          }
          yield* Ref.update(probes, (all) => {
            const next = new Map(all);
            next.delete(id);
            return next;
          });
          yield* Ref.update(capabilities, (all) => {
            const next = new Map(all);
            next.delete(id);
            return next;
          });
        });

      const summariesFor = (settings: Settings): Effect.Effect<ReadonlyArray<ConnectorSummary>> =>
        Effect.gen(function* () {
          const probedAt = yield* now;
          const probeMap = yield* Ref.get(probes);
          const caps = yield* Ref.get(capabilities);
          return settings.connectors.map(
            (conn): ConnectorSummary => ({
              connectorInstanceId: conn.connectorInstanceId,
              kind: conn.kind,
              displayName: conn.displayName,
              enabled: conn.enabled,
              capabilities: caps.get(conn.connectorInstanceId) ?? null,
              probe:
                (probeMap.get(conn.connectorInstanceId) !== undefined
                  ? toWireProbe(probeMap.get(conn.connectorInstanceId)!)
                  : probingProbe(probedAt)),
            }),
          );
        });

      /** Brings open instances and probe results in line with one settings document. */
      const reconcile = (settings: Settings): Effect.Effect<void> =>
        Effect.gen(function* () {
          const seen = new Set<string>();
          for (const conn of settings.connectors) {
            const id = conn.connectorInstanceId;
            seen.add(id);
            const signature = JSON.stringify({
              kind: conn.kind,
              config: conn.config,
              enabled: conn.enabled,
            });
            const existing = (yield* Ref.get(entries)).get(id);
            if (existing?.signature === signature) {
              continue;
            }
            if (existing !== undefined) {
              yield* closeEntry(id, existing);
            }
            const probe = yield* probeOf(conn);
            yield* Ref.update(probes, (all) => new Map(all).set(id, probe));
            const scope = conn.enabled ? yield* openInstance(conn) : null;
            yield* Ref.update(entries, (all) => new Map(all).set(id, { signature, scope }));
          }
          const current = yield* Ref.get(entries);
          for (const [id, entry] of current) {
            if (!seen.has(id)) {
              yield* closeEntry(id, entry);
              yield* Ref.update(entries, (all) => {
                const next = new Map(all);
                next.delete(id);
                return next;
              });
            }
          }
          yield* SubscriptionRef.set(summariesRef, yield* summariesFor(settings));
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("reconcile failed", cause)));

      /**
       * First run only: an empty connectors list with no settings row behind it
       * gets one enabled instance per registered definition. The update emits
       * a fresh settings value, which the loop reconciles like any other edit.
       */
      const maybeSeed = (settings: Settings): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (yield* Ref.get(seeded)) {
            return false;
          }
          yield* Ref.set(seeded, true);
          if (
            !store.freshInstall ||
            settings.connectors.length > 0 ||
            registry.definitions.length === 0
          ) {
            return false;
          }
          yield* store
            .update({
              connectors: registry.definitions.map((definition) => ({
                connectorInstanceId: makeConnectorInstanceId(),
                kind: definition.kind,
                displayName: definition.displayName,
                enabled: true,
                config: definition.defaultConfig(),
              })),
            })
            .pipe(Effect.catchCause((cause) => Effect.logWarning("seed failed", cause)));
          return true;
        });

      yield* Stream.runForEach(store.changes, (settings) =>
        Effect.flatMap(maybeSeed(settings), (didSeed) =>
          didSeed ? Effect.void : mutex.withPermits(1)(reconcile(settings)),
        ),
      ).pipe(Effect.forkScoped);

      const list = (refresh = false): Effect.Effect<ReadonlyArray<ConnectorSummary>> =>
        Effect.gen(function* () {
          const settings = yield* store.get;
          if (refresh) {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                for (const conn of settings.connectors) {
                  const probe = yield* probeOf(conn);
                  yield* Ref.update(probes, (all) =>
                    new Map(all).set(conn.connectorInstanceId, probe),
                  );
                }
                yield* SubscriptionRef.set(summariesRef, yield* summariesFor(settings));
              }),
            );
          }
          return yield* summariesFor(settings);
        });

      const models = (instanceId: ConnectorInstanceId) =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(probes)).get(instanceId);
          if (cached !== undefined) {
            return cached.models;
          }
          return yield* registry.instance(instanceId).pipe(
            Effect.flatMap((instance) => instance.listModels()),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ModelOption>)),
          );
        });

      return ConnectorManager.of({
        list,
        models,
        changes: SubscriptionRef.changes(summariesRef),
      });
    }),
  );

  /** The RPC-facing catalog, answered from manager state. */
  static readonly catalogLayer = Layer.effect(
    ConnectorCatalog,
    Effect.gen(function* () {
      const manager = yield* ConnectorManager;
      return ConnectorCatalog.of({
        list: (refresh) => manager.list(refresh),
        models: (instanceId) => manager.models(instanceId),
      });
    }),
  );
}
