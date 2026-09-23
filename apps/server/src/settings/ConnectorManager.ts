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
 * reconciles the current document and then re-runs every probe, which is what
 * the settings page's probe button — and every save, which refreshes right
 * after it writes — triggers. Reconciling there rather than waiting for the
 * subscription's own pass is what keeps the two from racing for the mutex.
 *
 * A reconcile registers before it probes, and `ready` completes once the first
 * pass has registered everything the settings document asks for. The
 * entrypoint waits on it before the handshake, so no client is admitted while
 * `ConnectorSelection` would still answer `NoConnector` — a probe that takes
 * its full timeout must not decide whether the first turn of a boot can run.
 */

import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import { makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary, ModelOption } from "@OpenAde/contracts/connectors";
import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";
import type { ConnectorProbe } from "@OpenAde/connector-sdk/definition";
import { toWireProbe } from "@OpenAde/connector-sdk/definition";
import type { ConnectorRegistry } from "@OpenAde/connector-sdk/registry";
import type { ConnectorInstanceConfig, Settings } from "@OpenAde/contracts/settings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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

/** What an open instance declared, kept for the summaries. */
interface Declared {
  readonly capabilities: ConnectorCapabilities;
  readonly extensions: ConnectorSummary["extensions"];
}

/** A closed instance manages nothing: the Customize page shows no section for it. */
const NO_EXTENSIONS: ConnectorSummary["extensions"] = { skills: false, mcpServers: false };

/** A probe gets this long before it's reported as an error. */
const PROBE_TIMEOUT = Duration.seconds(15);

export class ConnectorManager extends Context.Service<
  ConnectorManager,
  {
    readonly list: (refresh?: boolean) => Effect.Effect<ReadonlyArray<ConnectorSummary>>;
    readonly models: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<ModelOption>>;
    /**
     * Completes when the first reconcile has opened every enabled instance the
     * settings document asks for — probes may still be running. The entrypoint
     * waits on this before the handshake so the first turn of a boot has a
     * registered instance to route to.
     */
    readonly ready: Effect.Effect<void>;
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
      /** What each open instance declared: its capabilities and which extensions it carries. */
      const declared = yield* Ref.make<ReadonlyMap<string, Declared>>(new Map());
      /**
       * What `listModels()` last answered for an instance whose probe found no
       * models. Asking is a re-probe for some connectors — two child processes
       * for the cmd one — and the model pickers ask on every mount, so the
       * answer is kept until the next probe replaces it.
       */
      const fallbackModels = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ModelOption>>>(
        new Map(),
      );
      /** Latest summary list — replays to new subscribers, so none miss a reconcile. */
      const summariesRef = yield* SubscriptionRef.make<ReadonlyArray<ConnectorSummary>>([]);
      /** Serialises reconcile passes and explicit re-probes. */
      const mutex = yield* Semaphore.make(1);
      const seeded = yield* Ref.make(false);
      /** Completed by the first reconcile, once it has registered instances. */
      const registered = yield* Deferred.make<void>();

      const now = Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (ms) => new Date(ms).toISOString(),
      );

      /** One probe of one configured entry; never fails — failures are data. */
      const probeOf = (conn: ConnectorInstanceConfig): Effect.Effect<ConnectorProbe> =>
        Effect.gen(function* () {
          const probedAt = yield* now;
          const definition = yield* registry.definitionFor(conn.kind).pipe(Effect.option);
          if (Option.isNone(definition)) {
            return failedProbe(`this build has no connector for kind "${conn.kind}"`, probedAt);
          }
          const outcome = yield* definition.value
            .probe(conn.config)
            .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.exit);
          if (Exit.isFailure(outcome)) {
            return failedProbe(Cause.pretty(outcome.cause), probedAt);
          }
          return Option.getOrElse(outcome.value, () => failedProbe("probe timed out", probedAt));
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
          const { capabilities, extensions } = opened.value;
          yield* Ref.update(declared, (all) =>
            new Map(all).set(conn.connectorInstanceId, {
              capabilities,
              extensions: {
                skills: extensions?.skills !== undefined,
                mcpServers: extensions?.mcpServers !== undefined,
              },
            }),
          );
          return scope;
        });

      const forget = <A>(ref: Ref.Ref<ReadonlyMap<string, A>>, id: string): Effect.Effect<void> =>
        Ref.update(ref, (all) => {
          const next = new Map(all);
          next.delete(id);
          return next;
        });

      /** Records a fresh probe, which retires whatever the fallback memoized. */
      const recordProbe = (id: string, probe: ConnectorProbe): Effect.Effect<void> =>
        Effect.andThen(
          Ref.update(probes, (all) => new Map(all).set(id, probe)),
          forget(fallbackModels, id),
        );

      const closeEntry = (id: string, entry: Entry): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (entry.scope !== null) {
            yield* Scope.close(entry.scope, Exit.void);
          }
          yield* forget(probes, id);
          yield* forget(declared, id);
          yield* forget(fallbackModels, id);
        });

      const summariesFor = (settings: Settings): Effect.Effect<ReadonlyArray<ConnectorSummary>> =>
        Effect.gen(function* () {
          const probedAt = yield* now;
          const probeMap = yield* Ref.get(probes);
          const opened = yield* Ref.get(declared);
          return settings.connectors.map((conn): ConnectorSummary => ({
            connectorInstanceId: conn.connectorInstanceId,
            kind: conn.kind,
            displayName: conn.displayName,
            enabled: conn.enabled,
            capabilities: opened.get(conn.connectorInstanceId)?.capabilities ?? null,
            extensions: opened.get(conn.connectorInstanceId)?.extensions ?? NO_EXTENSIONS,
            probe:
              probeMap.get(conn.connectorInstanceId) !== undefined
                ? toWireProbe(probeMap.get(conn.connectorInstanceId)!)
                : probingProbe(probedAt),
          }));
        });

      /**
       * Brings open instances and probe results in line with one settings
       * document. Registration comes first and probing second: a probe may
       * take `PROBE_TIMEOUT`, and nothing that routes a turn should wait on it.
       */
      const reconcile = (
        settings: Settings,
        /** `false` when the caller probes every entry itself right afterwards. */
        probeChanged = true,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const seen = new Set<string>();
          const changed: Array<ConnectorInstanceConfig> = [];
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
            const scope = conn.enabled ? yield* openInstance(conn) : null;
            yield* Ref.update(entries, (all) => new Map(all).set(id, { signature, scope }));
            changed.push(conn);
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
          // The registry now matches the document; clients may be admitted.
          yield* Deferred.succeed(registered, undefined);
          for (const conn of probeChanged ? changed : []) {
            const probe = yield* probeOf(conn);
            yield* recordProbe(conn.connectorInstanceId, probe);
          }
          yield* SubscriptionRef.set(summariesRef, yield* summariesFor(settings));
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("reconcile failed", cause)),
          // A pass that died or was interrupted must not strand the entrypoint;
          // the registry is then as close to the document as it will get.
          Effect.ensuring(Effect.asVoid(Deferred.succeed(registered, undefined))),
        );

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
          const written = yield* store
            .update({
              connectors: registry.definitions.map((definition) => ({
                connectorInstanceId: makeConnectorInstanceId(),
                kind: definition.kind,
                displayName: definition.metadata.displayName,
                enabled: true,
                config: definition.defaultConfig(),
              })),
            })
            .pipe(Effect.exit);
          if (Exit.isFailure(written)) {
            // No new settings value was emitted, so no reconcile is coming for
            // it. Report "did not seed" and let this pass reconcile instead —
            // `ready` hangs otherwise, and with it the entrypoint.
            yield* Effect.logWarning("seed failed", written.cause);
            return false;
          }
          return true;
        });

      yield* Stream.runForEach(store.changes, (settings) =>
        Effect.flatMap(maybeSeed(settings), (didSeed) =>
          didSeed ? Effect.void : mutex.withPermits(1)(reconcile(settings)),
        ),
      ).pipe(Effect.forkScoped);

      const list = (refresh = false): Effect.Effect<ReadonlyArray<ConnectorSummary>> =>
        refresh
          ? mutex.withPermits(1)(
              Effect.gen(function* () {
                // The settings page refreshes right after it writes, so the
                // reconcile for that write may not have run yet. Running it
                // here — it is a no-op once signatures match — is what stops
                // the two racing for the mutex: a reconcile that lands after
                // the refresh would drop these probes and leave the card
                // reading "Probing…" until the user pressed the button again.
                const settings = yield* store.get;
                yield* reconcile(settings, false);
                for (const conn of settings.connectors) {
                  const probe = yield* probeOf(conn);
                  yield* recordProbe(conn.connectorInstanceId, probe);
                }
                const summaries = yield* summariesFor(settings);
                yield* SubscriptionRef.set(summariesRef, summaries);
                return summaries;
              }),
            )
          : Effect.flatMap(store.get, summariesFor);

      const models = (instanceId: ConnectorInstanceId) =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(probes)).get(instanceId);
          // Reconcile always records a probe, and a failed or timed-out one
          // carries an empty list — so only a probe that actually found models
          // may answer. Otherwise ask the open instance, which is the thing
          // the model pickers would otherwise be left empty by.
          if (cached !== undefined && cached.models.length > 0) {
            return cached.models;
          }
          const memoized = (yield* Ref.get(fallbackModels)).get(instanceId);
          if (memoized !== undefined) {
            return memoized;
          }
          // `listModels()` is a full re-probe for some connectors, so it gets
          // the same bound as a probe, and the answer is memoized until the
          // next probe: the pickers ask once per mount, per instance.
          const found = yield* registry.instance(instanceId).pipe(
            Effect.flatMap((instance) => instance.listModels()),
            Effect.timeoutOption(PROBE_TIMEOUT),
            Effect.map(Option.getOrElse(() => [] as ReadonlyArray<ModelOption>)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<ModelOption>)),
          );
          yield* Ref.update(fallbackModels, (all) => new Map(all).set(instanceId, found));
          return found;
        });

      return ConnectorManager.of({
        list,
        models,
        ready: Deferred.await(registered),
        changes: SubscriptionRef.changes(summariesRef),
      });
    }),
  );

  /**
   * The RPC-facing catalog, answered from manager state — and, for
   * `describe`, straight from the registry: what this build ships does not
   * depend on what the settings document configures.
   */
  static readonly catalogLayer = Layer.effect(
    ConnectorCatalog,
    Effect.gen(function* () {
      const manager = yield* ConnectorManager;
      const registry = yield* ConnectorRegistryService;
      return ConnectorCatalog.of({
        list: (refresh) => manager.list(refresh),
        models: (instanceId) => manager.models(instanceId),
        describe: Effect.succeed(registry.describe),
      });
    }),
  );
}
