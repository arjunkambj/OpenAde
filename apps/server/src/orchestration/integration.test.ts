import { describe, expect, it } from "@effect/vitest";
import {
  makeCommandId,
  makeConnectorInstanceId,
  makeItemId,
  makeProjectId,
  makeThreadId,
} from "@OpenAde/contracts/ids";
import type { Command, OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import type { ConnectorInstance, ConnectorServices } from "@OpenAde/connector-sdk/definition";
import { SpawnFailed } from "@OpenAde/connector-sdk/definition";
import {
  approvalTurnScript,
  makeFakeConnector,
  type FakeConnector,
  type FakeTurnScript,
} from "@OpenAde/testkit/fakeConnector";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";

import type { PlannedEvent } from "../persistence/EventStore";
import { EngineEnv, OrchestrationEngine } from "./Engine";
import { SessionManager } from "./SessionManager";
import { engineLayer, stackLayer } from "../../test/layers";

const NOW = "2026-01-02T03:04:05.000Z";

/** The services bag connectors are handed — the fake ignores it. */
const services = Effect.clockWith((clock) =>
  Effect.succeed<ConnectorServices>({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("allow" as const) },
    attachmentsDir: "/tmp/openade-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const openFake = (
  options: Parameters<typeof makeFakeConnector>[0] = {},
): Effect.Effect<
  { fake: FakeConnector; instance: ConnectorInstance },
  import("@OpenAde/connector-sdk/definition").ConnectorError,
  import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const fake = yield* makeFakeConnector(options);
    const instance = yield* fake.definition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {},
      services: yield* services,
    });
    return { fake, instance };
  });

const projectId = makeProjectId();
const threadId = makeThreadId();

const createProject: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "project.create",
  projectId,
  name: "demo",
  workspaceRoot: "/repo",
};

const createThread: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model" },
};

const createPlanThread: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model", interactionMode: "plan" },
};

const turnStart = (text: string, queued = false): Command => ({
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.turn.start",
  threadId,
  text,
  attachments: [],
  mentions: [],
  queued,
});

/**
 * A fiber that completes with the first matching event. Fork it *before* the
 * action that produces the event — a PubSub subscription only sees what
 * happens after it was created.
 */
const awaitEvent = (
  engine: OrchestrationEngine["Service"],
  pred: (event: OrchestrationEvent) => boolean,
) =>
  Effect.gen(function* () {
    const mailbox = yield* engine.subscribeEvents;
    return yield* Stream.fromSubscription(mailbox).pipe(
      Stream.filter(pred),
      Stream.runHead,
      Effect.forkChild,
    );
  });

const isType =
  (type: OrchestrationEvent["type"]) =>
  (event: OrchestrationEvent): boolean =>
    event.type === type;

describe("orchestration with a fake connector", () => {
  it.effect("runs a scripted turn end to end", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("idle");
        const message = detail?.items.find((item) => item.kind === "assistant_message");
        expect(message?.text).toContain("Fake reply to: hello");
        expect(detail?.session).not.toBeNull();
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      expect(session).not.toBeUndefined();
      const calls = yield* session!.calls;
      expect(calls.map((call) => call.method)).toContain("send");
    }),
  );

  it.effect("routes an approval through the reactor back to the session", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake({ script: approvalTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const requested = yield* awaitEvent(engine, isType("thread.approval.opened"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("npm run build"));
        const opened = yield* Fiber.join(requested);
        expect(Option.isSome(opened)).toBe(true);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("waiting");
        expect(detail?.pendingApproval).not.toBeNull();
        const requestId = detail!.pendingApproval!.requestId;

        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.approval.respond",
          threadId,
          requestId,
          decision: "allow-once",
        });
        yield* Fiber.join(completed);

        const after = yield* engine.threadDetail(threadId);
        expect(after?.status).toBe("idle");
        expect(after?.pendingApproval).toBeNull();
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const respond = calls.find((call) => call.method === "respondToRequest");
      expect(respond?.detail.decision).toBe("allow-once");
    }),
  );

  it.effect("plan accept leaves plan mode for the implement turn", () =>
    Effect.gen(function* () {
      // A turn that proposes a plan and stops there.
      const planTurnScript: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "turn.plan.proposed",
          payload: { turnId, planMarkdown: "# the plan" },
        },
      ];
      const { fake, instance } = yield* openFake({ script: planTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createPlanThread);

        const firstCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("plan it"));
        yield* Fiber.join(firstCompleted);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("waiting");
        expect(detail?.settings.interactionMode).toBe("plan");
        const planTurnId = detail!.pendingPlan!.turnId;

        const secondCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.plan.respond",
          threadId,
          turnId: planTurnId,
          action: "accept",
        });
        yield* Fiber.join(secondCompleted);

        // Accept must leave plan mode — otherwise the implement turn produces
        // yet another plan forever.
        const after = yield* engine.threadDetail(threadId);
        expect(after?.settings.interactionMode).toBe("default");
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const sends = calls.filter((call) => call.method === "send");
      expect(sends.map((call) => call.detail.text)).toContain("Implement the approved plan.");
      const settings = calls.filter((call) => call.method === "updateSettings");
      expect(settings.map((call) => call.detail.patch)).toContainEqual({
        interactionMode: "default",
      });
    }),
  );

  it.effect("plan accept-auto leaves plan mode and switches runtime mode", () =>
    Effect.gen(function* () {
      const planTurnScript: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "turn.plan.proposed",
          payload: { turnId, planMarkdown: "# the plan" },
        },
      ];
      const { fake, instance } = yield* openFake({ script: planTurnScript });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createPlanThread);

        const firstCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch(turnStart("plan it"));
        yield* Fiber.join(firstCompleted);

        const detail = yield* engine.threadDetail(threadId);
        const planTurnId = detail!.pendingPlan!.turnId;

        const secondCompleted = yield* awaitEvent(engine, isType("thread.turn.completed"));
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.plan.respond",
          threadId,
          turnId: planTurnId,
          action: "accept-auto",
        });
        yield* Fiber.join(secondCompleted);

        const after = yield* engine.threadDetail(threadId);
        expect(after?.settings.interactionMode).toBe("default");
        expect(after?.settings.runtimeMode).toBe("auto-accept-edits");
      }).pipe(Effect.provide(stackLayer({ instance })));

      const session = yield* fake.session(threadId);
      const calls = yield* session!.calls;
      const settings = calls.filter((call) => call.method === "updateSettings");
      expect(settings.map((call) => call.detail.patch)).toContainEqual({
        interactionMode: "default",
        runtimeMode: "auto-accept-edits",
      });
    }),
  );

  it.effect("deleting a thread stops the session instead of reporting a crash", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        const sessions = yield* SessionManager;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const bound = yield* awaitEvent(engine, isType("thread.session.bound"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(bound);

        // Subscribe before deleting: a PubSub subscription only sees what
        // lands after it exists.
        const ended = yield* sessions.lifecycle.pipe(
          Stream.filter((entry) => entry.kind === "ended"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId,
        });
        const entry = yield* Fiber.join(ended);
        // `stopped`, not `crashed` — a deliberate close must not look like a
        // loss, or the supervisor would try to resurrect it.
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry) && entry.value.kind === "ended") {
          expect(entry.value.reason).toBe("stopped");
        }
      }).pipe(
        Effect.provide(
          stackLayer({ instance, supervisor: { baseDelayMillis: 0, maxAttempts: 3 } }),
        ),
      );

      // The handle's close() actually ran — the imaginary process is gone.
      expect(yield* fake.processGone(threadId)).toBe(true);
      // And nothing resurrected a session for the deleted thread.
      expect((yield* fake.sessions).length).toBe(1);
    }),
  );

  it.effect("resumes a crashed session and re-runs the in-flight turn", () =>
    Effect.gen(function* () {
      // No turn.completed in the script body — the turn stays in flight until
      // the fake's own completion fires, so a crash mid-replay is mid-turn.
      const script: FakeTurnScript = ({ turnId }) => [
        {
          turnId,
          type: "item.started",
          payload: {
            item: {
              itemId: makeItemId(),
              kind: "assistant_message",
              status: "in_progress",
            },
          },
        },
      ];
      const { fake, instance } = yield* openFake({ script });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        // Subscribe for the *second* bound before the crash can produce it.
        const firstBound = yield* awaitEvent(engine, isType("thread.session.bound"));
        yield* engine.dispatch(turnStart("work"));
        yield* Fiber.join(firstBound);

        const secondBound = yield* awaitEvent(engine, isType("thread.session.bound"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));

        const session = yield* fake.session(threadId);
        expect(session).not.toBeUndefined();
        yield* session!.pause;
        yield* session!.crash({ exitCode: 137 });

        yield* Fiber.join(secondBound);
        yield* Fiber.join(completed);

        const detail = yield* engine.threadDetail(threadId);
        expect(detail?.status).toBe("idle");
        const all = yield* fake.sessions;
        expect(all.length).toBe(2);
      }).pipe(
        Effect.provide(
          stackLayer({
            instance,
            supervisor: { baseDelayMillis: 0, maxAttempts: 3 },
          }),
        ),
      );
    }),
  );

  it.effect("logs every failed resume attempt before declaring the session lost", () =>
    Effect.gen(function* () {
      const { fake, instance } = yield* openFake();
      // Same instance, but resume always fails — the crash below forces the
      // supervisor through its whole retry budget.
      const brokenResume: ConnectorInstance = {
        ...instance,
        resumeSession: () =>
          Effect.fail(
            new SpawnFailed({
              kind: instance.kind,
              instanceId: instance.instanceId,
              message: "process image is gone",
            }),
          ),
      };
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const bound = yield* awaitEvent(engine, isType("thread.session.bound"));
        const completed = yield* awaitEvent(engine, isType("thread.turn.completed"));
        const lost = yield* awaitEvent(engine, isType("thread.session.lost"));
        yield* engine.dispatch(turnStart("hello"));
        yield* Fiber.join(bound);
        yield* Fiber.join(completed);

        const session = yield* fake.session(threadId);
        yield* session!.crash();
        yield* Fiber.join(lost);
      }).pipe(
        Effect.provide(
          stackLayer({
            instance: brokenResume,
            supervisor: { baseDelayMillis: 0, maxAttempts: 3 },
          }),
        ),
      );

      const lines = yield* TestConsole.logLines;
      const attempts = lines.filter(
        (line) => typeof line === "string" && line.includes("resume attempt"),
      );
      expect(attempts).toHaveLength(3);
      expect(attempts[0]).toContain("resume attempt 1 of 3");
    }),
  );
});

// ── Deterministic projections ────────────────────────────────

/** UUIDv7-shaped ids from a counter — valid for every brand. */
const seededEnv = () => {
  let n = 0;
  const next = () => `00000000-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
  return {
    now: () => "2026-01-02T03:04:05.000Z",
    nextEventId: () => next() as never,
    nextTurnId: () => next() as never,
    nextItemId: () => next() as never,
  };
};

const deterministicRun = () => {
  const env = seededEnv();
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    yield* engine.dispatch(createProject);
    yield* engine.dispatch(createThread);
    yield* engine.dispatch(turnStart("hello"));

    const detail = yield* engine.threadDetail(threadId);
    const turnId = detail!.currentTurnId!;

    yield* engine.appendThreadEvents(threadId, [
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.turn.started",
        payload: { turnId },
      } as PlannedEvent,
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.item.upserted",
        payload: {
          item: {
            itemId: env.nextItemId(),
            kind: "assistant_message",
            status: "completed",
            text: "done",
          },
        },
      } as PlannedEvent,
      {
        eventId: env.nextEventId(),
        streamKind: "thread",
        streamId: threadId,
        occurredAt: env.now(),
        actor: "connector",
        type: "thread.turn.completed",
        payload: { turnId, stopReason: "end_turn" },
      } as PlannedEvent,
    ]);
    return yield* engine.threadDoc(threadId);
  }).pipe(Effect.provide(engineLayer()), Effect.provideService(EngineEnv, env));
};

describe("projection determinism", () => {
  it.effect("produces byte-identical documents across two runs", () =>
    Effect.gen(function* () {
      const first = yield* deterministicRun();
      const second = yield* deterministicRun();
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first?.status).toBe("idle");
      expect(first?.items).toHaveLength(1);
    }),
  );
});
