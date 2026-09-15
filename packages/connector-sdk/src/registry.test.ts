import { makeConnectorInstanceId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ConnectorDefinition, ConnectorInstance, ConnectorServices } from "./definition";
import { eraseConnectorDefinition } from "./definition";
import { makeRegistry } from "./registry";
import type { SessionHandle } from "./sessionHandle";

/** The bag of server services a connector is handed, stubbed down to nothing. */
const makeServices: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "test" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "test" }),
    permissions: { decide: () => Effect.succeed("allow" as const) },
    attachmentsDir: "/tmp/openade-registry-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const StubConfig = Schema.Struct({ label: Schema.String });
type StubConfig = typeof StubConfig.Type;

const idleHandle: SessionHandle = {
  events: Stream.empty,
  send: () => Effect.void,
  interrupt: () => Effect.void,
  respondToRequest: () => Effect.void,
  respondToUserInput: () => Effect.void,
  respondToPlan: () => Effect.void,
  updateSettings: () => Effect.void,
  sessionRef: () => Effect.succeed(null),
  close: () => Effect.void,
};

/** A definition whose instances remember the label they were configured with. */
const stubDefinition = (kind: string): ConnectorDefinition<StubConfig> => ({
  kind,
  displayName: `Stub ${kind}`,
  configSchema: StubConfig,
  defaultConfig: () => ({ label: "default" }),
  probe: () =>
    Effect.succeed({
      status: "ready" as const,
      probedAt: new Date(0).toISOString(),
      auth: "present" as const,
      models: [],
      warnings: [],
    }),
  createInstance: ({ instanceId, config }) =>
    Effect.succeed<ConnectorInstance>({
      instanceId,
      kind,
      capabilities: {
        modelSwitch: "per-turn",
        effortSwitch: "per-turn",
        steering: false,
        planMode: true,
        subagents: true,
        images: false,
        resume: true,
        fork: true,
      },
      startSession: () => Effect.succeed(idleHandle),
      resumeSession: () => Effect.succeed(idleHandle),
      listModels: () =>
        Effect.succeed([
          { id: config.label, label: config.label, family: "stub", efforts: ["medium" as const] },
        ]),
    }),
});

describe("makeRegistry", () => {
  it.effect("routes to the instance, not to the kind", () =>
    Effect.gen(function* () {
      const services = yield* makeServices;
      const registry = yield* makeRegistry([eraseConnectorDefinition(stubDefinition("stub"))]);
      const first = makeConnectorInstanceId();
      const second = makeConnectorInstanceId();

      yield* registry.open({
        instanceId: first,
        kind: "stub",
        config: { label: "work" },
        services,
      });
      yield* registry.open({
        instanceId: second,
        kind: "stub",
        config: { label: "personal" },
        services,
      });

      // Same kind, same definition, different configuration: the id decides.
      const fromFirst = yield* (yield* registry.instance(first)).listModels();
      const fromSecond = yield* (yield* registry.instance(second)).listModels();
      expect(fromFirst[0]?.id).toBe("work");
      expect(fromSecond[0]?.id).toBe("personal");
      expect((yield* registry.instances).length).toBe(2);
    }),
  );

  it.effect("fails for an instance id nothing was opened under", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry([eraseConnectorDefinition(stubDefinition("stub"))]);
      const error = yield* registry.instance(makeConnectorInstanceId()).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectorNotFound");
      expect(error.kind).toBeNull();
    }),
  );

  it.effect("fails for a kind no definition claims", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry([eraseConnectorDefinition(stubDefinition("stub"))]);
      const error = yield* registry.definitionFor("nothing-like-this").pipe(Effect.flip);
      expect(error._tag).toBe("ConnectorNotFound");
      expect(error.kind).toBe("nothing-like-this");
    }),
  );

  it.effect("validates configuration through the connector's own schema", () =>
    Effect.gen(function* () {
      const services = yield* makeServices;
      const registry = yield* makeRegistry([eraseConnectorDefinition(stubDefinition("stub"))]);
      const error = yield* registry
        .open({
          instanceId: makeConnectorInstanceId(),
          kind: "stub",
          config: { label: 7 },
          services,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("SpawnFailed");
    }),
  );

  it.effect("forgets an instance once its scope closes", () =>
    Effect.gen(function* () {
      const services = yield* makeServices;
      const registry = yield* makeRegistry([eraseConnectorDefinition(stubDefinition("stub"))]);
      const instanceId = makeConnectorInstanceId();

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.open({ instanceId, kind: "stub", config: { label: "temp" }, services });
          expect((yield* registry.instances).length).toBe(1);
        }),
      );

      expect((yield* registry.instances).length).toBe(0);
      const started = yield* registry.instance(instanceId).pipe(Effect.flip);
      expect(started._tag).toBe("ConnectorNotFound");
    }),
  );
});
