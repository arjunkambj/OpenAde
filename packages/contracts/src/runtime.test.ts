import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeConnectorInstanceId, makeEventId, makeThreadId } from "./ids";
import { RuntimeEvent, RuntimeEventType, runtimeEventTypes } from "./runtime";

const envelope = () => ({
  eventId: makeEventId(),
  connectorInstanceId: makeConnectorInstanceId(),
  threadId: makeThreadId(),
  createdAt: "2026-09-15T12:00:00.000Z",
});

describe("RuntimeEvent", () => {
  it.effect("declares one union member per RuntimeEventType, in the same order", () =>
    Effect.gen(function* () {
      const fromUnion = yield* Effect.succeed(runtimeEventTypes);
      expect(fromUnion).toEqual(RuntimeEventType.literals);
    }),
  );

  it.effect("has no duplicate type tags", () =>
    Effect.gen(function* () {
      const tags = yield* Effect.succeed(runtimeEventTypes);
      expect(new Set(tags).size).toBe(tags.length);
    }),
  );
});

describe("event.unmapped", () => {
  const decode = Schema.decodeUnknownExit(RuntimeEvent);

  it.effect("keeps the frame it could not translate", () =>
    Effect.gen(function* () {
      const decoded = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(RuntimeEvent)({
          ...envelope(),
          type: "event.unmapped",
          payload: {},
          raw: { source: "cmd.ndjson", payload: { type: "something_new" } },
        }),
      );
      expect(decoded.type).toBe("event.unmapped");
      expect(decoded.raw?.source).toBe("cmd.ndjson");
    }),
  );

  it.effect("is rejected without raw, because the frame is the whole point", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        decode({ ...envelope(), type: "event.unmapped", payload: {} }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("leaves raw optional on a translated event", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.sync(() =>
        decode({ ...envelope(), type: "session.warning", payload: { message: "slow start" } }),
      );
      expect(exit._tag).toBe("Success");
    }),
  );
});
