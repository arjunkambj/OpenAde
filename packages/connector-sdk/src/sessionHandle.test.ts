import {
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  EVENT_QUEUE_CAPACITY,
  TERMINAL_EVENT_RESERVE,
  isTerminalEvent,
  makeBoundedEventQueue,
} from "./sessionHandle";

const connectorInstanceId = makeConnectorInstanceId();
const threadId = makeThreadId();
const turnId = makeTurnId();

const envelope = () => ({
  eventId: makeEventId(),
  connectorInstanceId,
  threadId,
  createdAt: new Date(0).toISOString(),
});

const chatter = (): RuntimeEvent => ({
  ...envelope(),
  type: "content.delta",
  payload: { itemId: makeItemId(), kind: "text", delta: "x" },
});

const completed = (): RuntimeEvent => ({
  ...envelope(),
  turnId,
  type: "turn.completed",
  payload: { turnId, stopReason: "end_turn" },
});

describe("bounded event queue", () => {
  it.effect("keeps the reserve free for terminal events", () =>
    Effect.gen(function* () {
      const queue = yield* makeBoundedEventQueue({ capacity: 8, reserve: 2 });

      const ordinary: Array<boolean> = [];
      for (let index = 0; index < 8; index += 1) {
        ordinary.push(yield* queue.offer(chatter()));
      }

      // Six fit; the seventh onwards is refused because the reserve starts there.
      expect(ordinary).toEqual([true, true, true, true, true, true, false, false]);
      expect(yield* queue.dropped).toBe(2);

      // The reserve is still there for the events that end the turn.
      expect(yield* queue.offer(completed())).toBe(true);
      expect(yield* queue.offer(completed())).toBe(true);
      expect(yield* queue.dropped).toBe(2);

      // And once even the reserve is gone, nothing more is taken.
      expect(yield* queue.offer(completed())).toBe(false);
      expect(yield* queue.dropped).toBe(3);
    }),
  );

  it.effect("delivers what it accepted, in order, and finishes on end", () =>
    Effect.gen(function* () {
      const queue = yield* makeBoundedEventQueue({ capacity: 4, reserve: 1 });
      const first = chatter();
      const second = chatter();
      const last = completed();

      yield* queue.offer(first);
      yield* queue.offer(second);
      yield* queue.offer(last);
      yield* queue.end;

      const delivered = yield* Stream.runCollect(queue.events);
      expect(delivered.map((event) => event.eventId)).toEqual([
        first.eventId,
        second.eventId,
        last.eventId,
      ]);
    }),
  );

  it.effect("defaults to the capacity and reserve the spec fixes", () =>
    Effect.gen(function* () {
      const queue = yield* makeBoundedEventQueue();
      const accepted: Array<boolean> = [];
      for (let index = 0; index < EVENT_QUEUE_CAPACITY; index += 1) {
        accepted.push(yield* queue.offer(chatter()));
      }
      const taken = accepted.filter(Boolean).length;
      expect(taken).toBe(EVENT_QUEUE_CAPACITY - TERMINAL_EVENT_RESERVE);
      expect(yield* queue.offer(completed())).toBe(true);
    }),
  );
});

describe("isTerminalEvent", () => {
  it.effect("names the three events that end something", () =>
    Effect.gen(function* () {
      const cases = yield* Effect.succeed([chatter(), completed()]);
      expect(cases.map(isTerminalEvent)).toEqual([false, true]);
    }),
  );
});
