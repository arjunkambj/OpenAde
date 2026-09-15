import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  Command,
  CommandType,
  OrchestrationEventType,
  ThreadStreamItem,
  commandTypes,
  orchestrationEventTypes,
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
