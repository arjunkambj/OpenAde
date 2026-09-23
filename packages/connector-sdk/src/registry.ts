/**
 * Which connector a thread talks to.
 *
 * The registry is deliberately small: an array of definitions, and a map of the
 * instances that are currently open. The one rule it enforces is that routing
 * is by **instance id**, never by kind. Two instances of the same harness with
 * different binaries, different credentials or different default models are a
 * normal configuration, and a thread bound to one of them must never be handed
 * the other because they happen to share a `kind`.
 *
 * Definitions are looked up by kind exactly once — when an instance is opened
 * from the settings document. After that the instance id is the only handle.
 */

import type { ConnectorInstanceId, ConnectorKind } from "@OpenAde/contracts/ids";
import type { ConnectorDescriptor } from "@OpenAde/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type {
  AnyConnectorDefinition,
  ConnectorError,
  ConnectorInstance,
  ConnectorServices,
} from "./definition";
import { ConnectorNotFound } from "./definition";

export interface OpenConnectorInput {
  readonly instanceId: ConnectorInstanceId;
  readonly kind: ConnectorKind;
  readonly config: unknown;
  readonly services: ConnectorServices;
}

export interface ConnectorRegistry {
  /** Every connector this build ships, in declaration order. */
  readonly definitions: ReadonlyArray<AnyConnectorDefinition>;
  /**
   * What `connectors.describe` answers: one entry per kind this build ships,
   * in declaration order, with the metadata and config form the connectors
   * page renders. A kind claimed twice is described once, like `definitionFor`.
   */
  readonly describe: ReadonlyArray<ConnectorDescriptor>;
  readonly definitionFor: (
    kind: ConnectorKind,
  ) => Effect.Effect<AnyConnectorDefinition, ConnectorNotFound>;
  /**
   * Opens one configured instance and registers it under its id for the
   * lifetime of the current scope. Closing the scope deregisters it.
   */
  readonly open: (
    input: OpenConnectorInput,
  ) => Effect.Effect<ConnectorInstance, ConnectorError, Scope.Scope>;
  readonly instance: (
    instanceId: ConnectorInstanceId,
  ) => Effect.Effect<ConnectorInstance, ConnectorNotFound>;
  readonly instances: Effect.Effect<ReadonlyArray<ConnectorInstance>>;
}

/**
 * Builds a registry over `definitions`. When two definitions claim the same
 * kind the first one wins, which makes the array's order the tie-break rather
 * than a map's insertion accident.
 */
export const makeRegistry = (
  definitions: ReadonlyArray<AnyConnectorDefinition>,
): Effect.Effect<ConnectorRegistry> =>
  Effect.gen(function* () {
    const openInstances = yield* Ref.make<ReadonlyMap<string, ConnectorInstance>>(new Map());

    const definitionFor = (
      kind: ConnectorKind,
    ): Effect.Effect<AnyConnectorDefinition, ConnectorNotFound> => {
      const found = definitions.find((definition) => definition.kind === kind);
      return found === undefined
        ? Effect.fail(new ConnectorNotFound({ instanceId: null, kind }))
        : Effect.succeed(found);
    };

    const instance = (
      instanceId: ConnectorInstanceId,
    ): Effect.Effect<ConnectorInstance, ConnectorNotFound> =>
      Ref.get(openInstances).pipe(
        Effect.flatMap((all) => {
          const found = all.get(instanceId);
          return found === undefined
            ? Effect.fail(new ConnectorNotFound({ instanceId, kind: null }))
            : Effect.succeed(found);
        }),
      );

    const open = (
      input: OpenConnectorInput,
    ): Effect.Effect<ConnectorInstance, ConnectorError, Scope.Scope> =>
      Effect.gen(function* () {
        const definition = yield* definitionFor(input.kind);
        const created = yield* definition.createInstance({
          instanceId: input.instanceId,
          config: input.config,
          services: input.services,
        });
        yield* Ref.update(openInstances, (all) => new Map(all).set(input.instanceId, created));
        yield* Effect.addFinalizer(() =>
          Ref.update(openInstances, (all) => {
            const next = new Map(all);
            next.delete(input.instanceId);
            return next;
          }),
        );
        return created;
      });

    const describe = definitions
      .filter(
        (definition, index) =>
          definitions.findIndex((other) => other.kind === definition.kind) === index,
      )
      .map((definition): ConnectorDescriptor => ({
        kind: definition.kind,
        metadata: definition.metadata,
        configFields: definition.configFields,
      }));

    return {
      definitions,
      describe,
      definitionFor,
      open,
      instance,
      instances: Ref.get(openInstances).pipe(Effect.map((all) => [...all.values()])),
    };
  });
