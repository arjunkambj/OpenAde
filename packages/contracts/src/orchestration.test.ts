import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  Attachment,
  Command,
  CommandType,
  OrchestrationEvent,
  OrchestrationEventType,
  ThreadStreamItem,
  commandTypes,
  orchestrationEventTypes,
  threadLocksConnector,
} from "./orchestration";

describe("Command", () => {
  it.effect("declares one union member per CommandType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(commandTypes);
      expect(fromUnion).toEqual(CommandType.literals);
    }),
  );

  it.effect("rejects a command that is missing its commandId", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(Command)({
          type: "thread.archive",
          createdAt: "2026-09-15T12:00:00.000Z",
          threadId: "0199b0f0-0000-7000-8000-000000000001",
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("OrchestrationEvent", () => {
  it.effect("declares one union member per OrchestrationEventType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(orchestrationEventTypes);
      expect(fromUnion).toEqual(OrchestrationEventType.literals);
    }),
  );

  it.effect("has no duplicate type tags", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed(orchestrationEventTypes);
      expect(new Set(tags).size).toBe(tags.length);
    }),
  );
});

describe("ThreadStreamItem", () => {
  const decode = Schema.decodeUnknownSync(ThreadStreamItem);

  it.effect("carries the four frames a subscriber can receive", () =>
    Effect.gen(function* () {
      const synchronized = yield* Effect.sync(() => decode({ kind: "synchronized" }));
      const resnapshot = yield* Effect.sync(() =>
        decode({ kind: "resnapshot-required", reason: "budget exceeded" }),
      );
      expect(synchronized.kind).toBe("synchronized");
      expect(resnapshot.kind).toBe("resnapshot-required");
    }),
  );

  it.effect("refuses a frame kind nothing knows how to render", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(ThreadStreamItem)({ kind: "partial" }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Attachment", () => {
  const decode = Schema.decodeUnknownSync(Attachment);

  it.effect("carries a reference to a staged file, never its bytes", () =>
    Effect.gen(function* () {
      const reference = {
        path: "/Users/dev/.openade/attachments/thread/3f8a1c0d9e2b-design.png",
        mime: "image/png",
        name: "design.png",
        size: 20481,
        sha256: "3f8a1c0d9e2b4a76c5d8e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0",
      };
      const decoded = yield* Effect.sync(() => decode(reference));
      const encoded = yield* Effect.sync(() => Schema.encodeUnknownSync(Attachment)(decoded));
      expect(encoded).toStrictEqual(reference);
      expect(Object.keys(reference)).not.toContain("base64");
    }),
  );

  it.effect("still accepts the bare path an earlier client would send", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.sync(() => decode({ path: "attachments/design.png" }));
      expect(decoded.name).toBeUndefined();
      expect(decoded.sha256).toBeUndefined();
    }),
  );

  it.effect("refuses a negative size", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        Schema.decodeUnknownExit(Attachment)({ path: "a.png", size: -1 }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("ThreadSettings.connectorInstanceId", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationEvent);
  const INSTANCE = "0199c0de-0003-7000-8000-000000000001";

  const threadCreated = (settings: Record<string, unknown>) => ({
    sequence: 3,
    eventId: "0199c0de-0006-7000-8000-000000000103",
    streamKind: "thread",
    streamId: "0199c0de-0002-7000-8000-000000000001",
    streamVersion: 1,
    occurredAt: "2026-09-15T12:00:03.000Z",
    actor: "user",
    type: "thread.created",
    payload: {
      threadId: "0199c0de-0002-7000-8000-000000000001",
      projectId: "0199c0de-0001-7000-8000-000000000001",
      title: "Health check endpoint",
      settings: {
        model: "vendor/model",
        runtimeMode: "approval-required",
        interactionMode: "default",
        ...settings,
      },
    },
  });

  it.effect("still decodes a thread.created written before threads chose a connector", () =>
    Effect.gen(function* () {
      const event = yield* Effect.sync(() => decode(threadCreated({})));
      if (event.type !== "thread.created") throw new Error(event.type);
      expect(event.payload.settings.connectorInstanceId).toBeUndefined();
    }),
  );

  it.effect("carries the instance a thread chose", () =>
    Effect.gen(function* () {
      const event = yield* Effect.sync(() =>
        decode(threadCreated({ connectorInstanceId: INSTANCE })),
      );
      if (event.type !== "thread.created") throw new Error(event.type);
      expect(event.payload.settings.connectorInstanceId).toBe(INSTANCE);
    }),
  );

  it.effect("travels on thread.settings.update", () =>
    Effect.gen(function* () {
      const command = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(Command)({
          commandId: "0199c0de-0008-7000-8000-000000000001",
          createdAt: "2026-09-15T12:00:00.000Z",
          type: "thread.settings.update",
          threadId: "0199c0de-0002-7000-8000-000000000001",
          connectorInstanceId: INSTANCE,
        }),
      );
      if (command.type !== "thread.settings.update") throw new Error(command.type);
      expect(command.connectorInstanceId).toBe(INSTANCE);
    }),
  );
});

describe("threadLocksConnector", () => {
  const fresh = { session: null, items: [], currentTurnId: null };

  it("leaves a thread nothing has run on free to choose", () => {
    expect(threadLocksConnector(fresh)).toBe(false);
    expect(threadLocksConnector({ ...fresh, items: [{ kind: "error" }] })).toBe(false);
  });

  it("locks once the user sent a message, a session is bound or a turn runs", () => {
    expect(threadLocksConnector({ ...fresh, items: [{ kind: "user_message" }] })).toBe(true);
    expect(threadLocksConnector({ ...fresh, session: { sessionRef: {} } })).toBe(true);
    expect(threadLocksConnector({ ...fresh, currentTurnId: "turn" })).toBe(true);
    // The server's own document names the running turn `currentTurn`.
    expect(threadLocksConnector({ session: null, items: [], currentTurn: {} })).toBe(true);
  });
});
