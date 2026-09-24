import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type {
  ConnectorServices,
  StartSessionInput,
  TurnInput,
} from "@poseidon/connector-sdk/definition";
import { runConnectorConformance } from "@poseidon/connector-sdk/conformance";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { FakeTurnScript } from "./fakeConnector";
import { approvalTurnScript, defaultTurnScript, makeFakeConnector } from "./fakeConnector";

/**
 * One script that covers both conformance cases: prompts starting with
 * `approve:` stop on an approval request, everything else just answers.
 */
const mixedScript: FakeTurnScript = (context) =>
  context.input.text.startsWith("approve:")
    ? approvalTurnScript(context)
    : defaultTurnScript(context);

const makeServices: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "test" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "test" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-fake-connector",
    logger: { log: () => Effect.void },
    clock,
  }),
);

const sessionInput = (): StartSessionInput => ({
  threadId: makeThreadId(),
  projectId: makeProjectId(),
  workspaceRoot: "/tmp/workspace",
  settings: {
    model: "fake/model",
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
});

const turn = (text: string): TurnInput => ({ text, attachments: [], mentions: [] });

/**
 * Opens one fake session and hands back everything a test needs to drive it:
 * the controller for pausing and crashing, the handle, and a live collector.
 */
const openFakeSession = (options?: Parameters<typeof makeFakeConnector>[0]) =>
  Effect.gen(function* () {
    const services = yield* makeServices;
    const fake = yield* makeFakeConnector(options);
    const instanceId = makeConnectorInstanceId();
    const instance = yield* fake.definition.createInstance({
      instanceId,
      config: {},
      services,
    });
    const input = sessionInput();
    const handle = yield* instance.startSession(input);
    const collector = yield* makeStreamCollector(handle.events);
    const session = yield* fake.session(input.threadId);
    if (session === undefined) {
      throw new Error("the fake did not register the session it just opened");
    }
    return { fake, handle, collector, session, threadId: input.threadId };
  });

describe("FakeConnector", () => {
  it.effect("announces the session it was asked to start", () =>
    Effect.gen(function* () {
      const { collector } = yield* openFakeSession();
      const started = yield* collector.awaitItem((event) => event.type === "session.started");
      expect(started.type === "session.started" ? started.payload.model : null).toBe("fake/model");
    }),
  );

  it.effect("replays the script and closes the turn itself", () =>
    Effect.gen(function* () {
      const { handle, collector } = yield* openFakeSession();

      yield* handle.send(turn("hello"));
      yield* collector.awaitItem((event) => event.type === "turn.completed");

      const types = (yield* collector.collected).map((event) => event.type);
      expect(types).toEqual([
        "session.started",
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "usage.updated",
        "turn.completed",
      ]);
    }),
  );

  it.effect("holds the replay while it is paused and resumes where it stopped", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession();

      yield* session.pause;
      yield* handle.send(turn("hello"));
      // `turn.started` is emitted before the first scripted event, so it still
      // arrives; nothing from the script does.
      yield* collector.awaitItem((event) => event.type === "turn.started");
      expect((yield* collector.collected).some((event) => event.type === "item.started")).toBe(
        false,
      );

      yield* session.resume;
      yield* collector.awaitItem((event) => event.type === "turn.completed");
      expect((yield* collector.collected).some((event) => event.type === "item.started")).toBe(
        true,
      );
    }),
  );

  it.effect("lets a test push its own events onto the stream", () =>
    Effect.gen(function* () {
      const { collector, session } = yield* openFakeSession();

      yield* session.emit({
        type: "runtime.error",
        payload: { message: "disk full", fatal: true },
      });

      const error = yield* collector.awaitItem((event) => event.type === "runtime.error");
      expect(error.type === "runtime.error" ? error.payload.message : null).toBe("disk full");
    }),
  );

  it.effect("ends the session with an exit code when it crashes", () =>
    Effect.gen(function* () {
      const { collector, session } = yield* openFakeSession();

      yield* session.crash({ exitCode: 130 });

      const ended = yield* collector.awaitItem((event) => event.type === "session.ended");
      expect(ended.type === "session.ended" ? ended.payload : null).toEqual({
        reason: "crashed",
        exitCode: 130,
      });
      yield* collector.awaitDone;
      expect(yield* session.processGone).toBe(true);
    }),
  );

  it.effect("refuses a second turn while one is running and steering is off", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession();

      yield* session.pause;
      yield* handle.send(turn("first"));
      yield* collector.awaitItem((event) => event.type === "turn.started");
      const error = yield* handle.send(turn("second")).pipe(Effect.flip);

      expect(error._tag).toBe("TurnInProgress");
    }),
  );

  it.effect("accepts overlapping turns when steering is configured on", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession({
        capabilities: { steering: true },
      });

      yield* session.pause;
      yield* handle.send(turn("first"));
      yield* collector.awaitItem((event) => event.type === "turn.started");
      yield* handle.send(turn("second"));
      yield* session.resume;

      const first = yield* collector.awaitItem((event) => event.type === "turn.completed");
      yield* collector.awaitItem(
        (event) => event.type === "turn.completed" && event.eventId !== first.eventId,
      );
    }),
  );

  it.effect("offers no steer while steering is off", () =>
    Effect.gen(function* () {
      const { handle } = yield* openFakeSession();
      expect(handle.steer).toBeUndefined();
    }),
  );

  it.effect("takes a steered message into the running turn and completes it once", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession({
        capabilities: { steering: true },
      });
      const steer = handle.steer;
      if (steer === undefined) {
        throw new Error("a steering fake must offer steer");
      }

      yield* session.pause;
      yield* handle.send(turn("first"));
      yield* collector.awaitItem((event) => event.type === "turn.started");
      yield* steer({ text: "and also this", attachments: [], mentions: ["README.md"] });
      yield* session.resume;
      yield* collector.awaitItem((event) => event.type === "turn.completed");

      const events = yield* collector.collected;
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(yield* session.calls).toEqual([
        {
          method: "send",
          detail: { text: "first", attachments: [], mentions: [], references: [] },
        },
        {
          method: "steer",
          detail: { text: "and also this", attachments: [], mentions: ["README.md"] },
        },
      ]);
    }),
  );

  it.effect("refuses a steer with no turn running", () =>
    Effect.gen(function* () {
      const { handle } = yield* openFakeSession({ capabilities: { steering: true } });
      const error = yield* Effect.flip(handle.steer?.(turn("nobody is listening")) ?? Effect.void);
      expect(error._tag).toBe("NotSteerable");
    }),
  );

  it.effect("refuses every steer when told to, while still advertising steering", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession({
        capabilities: { steering: true },
        refuseSteering: true,
      });

      yield* session.pause;
      yield* handle.send(turn("first"));
      yield* collector.awaitItem((event) => event.type === "turn.started");
      const error = yield* Effect.flip(handle.steer?.(turn("turned away")) ?? Effect.void);
      expect(error._tag).toBe("NotSteerable");
      expect((yield* session.calls).map((call) => call.method)).toEqual(["send", "steer"]);
    }),
  );

  it.effect("ends the turn as interrupted when the turn is interrupted", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession();

      yield* session.pause;
      yield* handle.send(turn("something long"));
      yield* collector.awaitItem((event) => event.type === "turn.started");
      yield* handle.interrupt();

      const completed = yield* collector.awaitItem((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" ? completed.payload.stopReason : null).toBe(
        "interrupted",
      );
      expect((yield* collector.collected).some((event) => event.type === "item.started")).toBe(
        false,
      );
    }),
  );

  it.effect("interrupting a turn that is waiting on an approval still ends it", () =>
    Effect.gen(function* () {
      const { handle, collector } = yield* openFakeSession({ script: approvalTurnScript });

      yield* handle.send(turn("rm -rf /"));
      yield* collector.awaitItem((event) => event.type === "request.opened");
      yield* handle.interrupt();

      const completed = yield* collector.awaitItem((event) => event.type === "turn.completed");
      expect(completed.type === "turn.completed" ? completed.payload.stopReason : null).toBe(
        "interrupted",
      );
    }),
  );

  it.effect("holds the turn open until an approval request is answered", () =>
    Effect.gen(function* () {
      const { handle, collector } = yield* openFakeSession({ script: approvalTurnScript });

      yield* handle.send(turn("rm -rf /"));
      const opened = yield* collector.awaitItem((event) => event.type === "request.opened");
      if (opened.type !== "request.opened") {
        throw new Error("collector returned the wrong event");
      }
      expect((yield* collector.collected).some((event) => event.type === "turn.completed")).toBe(
        false,
      );

      yield* handle.respondToRequest(opened.payload.request.requestId, "allow-once");
      yield* collector.awaitItem((event) => event.type === "turn.completed");
    }),
  );

  it.effect("records every call made against the handle", () =>
    Effect.gen(function* () {
      const { handle, collector, session } = yield* openFakeSession();

      yield* handle.send(turn("hello"));
      yield* collector.awaitItem((event) => event.type === "turn.completed");
      yield* handle.updateSettings({ model: "fake/other" });
      const changed = yield* collector.awaitItem((event) => event.type === "model.changed");
      expect(changed.type === "model.changed" ? changed.payload.model : null).toBe("fake/other");

      yield* handle.close();
      expect((yield* session.calls).map((call) => call.method)).toEqual([
        "send",
        "updateSettings",
        "close",
      ]);
    }),
  );
});

describe("FakeConnector against the conformance suite", () => {
  const conformance = Effect.runSync(
    Effect.gen(function* () {
      const services = yield* makeServices;
      const fake = yield* makeFakeConnector({ script: mixedScript });
      return { services, fake };
    }),
  );

  runConnectorConformance(conformance.fake.definition, {
    instanceId: makeConnectorInstanceId(),
    services: conformance.services,
    config: {},
    session: sessionInput(),
    turn: turn("hello"),
    approvalTurn: turn("approve: rm -rf /"),
    isProcessGone: conformance.fake.processGone,
  });
});
