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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { TurnInput } from "./definition";
import { SessionClosed } from "./definition";
import type { SessionHandle } from "./sessionHandle";
import { makeBoundedEventQueue } from "./sessionHandle";
import { makeTurnScopedHandle } from "./turnScopedHandle";

const connectorInstanceId = makeConnectorInstanceId();
const threadId = makeThreadId();

const turn = (text: string): TurnInput => ({ text, attachments: [], mentions: [] });

const envelope = () => ({
  eventId: makeEventId(),
  connectorInstanceId,
  threadId,
  createdAt: new Date(0).toISOString(),
});

const delta = (): RuntimeEvent => ({
  ...envelope(),
  type: "content.delta",
  payload: { itemId: makeItemId(), kind: "text", delta: "x" },
});

const sessionEnded = (reason: "stopped" | "crashed" | "interrupted"): RuntimeEvent => ({
  ...envelope(),
  type: "session.ended",
  payload: { reason },
});

const turnCompleted = (): RuntimeEvent => {
  const scriptedTurnId = makeTurnId();
  return {
    ...envelope(),
    type: "turn.completed",
    payload: { turnId: scriptedTurnId, stopReason: "end_turn" },
  };
};

/**
 * A handle whose harness is the test itself: events go in through `emit`, the
 * prompts that reached `send` come back out through `sent`.
 */
const makeScriptedHandle = () =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue({ capacity: 64, reserve: 8 });
    const sentRef = yield* Ref.make<ReadonlyArray<TurnInput>>([]);
    const failSendRef = yield* Ref.make(false);

    const handle: SessionHandle = {
      events: queue.events,
      send: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(failSendRef)) {
            return yield* Effect.fail(new SessionClosed({ threadId }));
          }
          yield* Ref.update(sentRef, (all) => [...all, input]);
        }),
      interrupt: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      respondToPlan: () => Effect.void,
      updateSettings: () => Effect.void,
      sessionRef: () => Effect.succeed(null),
      close: () => queue.end,
    };

    return {
      handle,
      emit: (event: RuntimeEvent) => queue.offer(event).pipe(Effect.asVoid),
      end: queue.end,
      sent: Ref.get(sentRef),
      refuseSends: Ref.set(failSendRef, true),
    };
  });

describe("makeTurnScopedHandle", () => {
  it.effect("stamps every event of an active turn with our turn id", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("hello"));
      yield* scripted.emit(delta());
      yield* scripted.emit(delta());
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      const deltas = events.filter((event) => event.type === "content.delta");
      expect(deltas.map((event) => event.turnId)).toEqual([turnId, turnId]);
      expect((yield* scripted.sent).map((input) => input.text)).toEqual(["hello"]);
    }),
  );

  it.effect("leaves events alone when no turn is active", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });

      yield* scripted.emit(delta());
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      expect(events.map((event) => event.turnId)).toEqual([undefined]);
    }),
  );

  it.effect("refuses a second turn while one is unsettled", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const first = makeTurnId();
      const second = makeTurnId();

      yield* scoped.send(first, turn("first"));
      const error = yield* scoped.send(second, turn("second")).pipe(Effect.flip);
      expect(error._tag).toBe("TurnInProgress");
      expect(error._tag === "TurnInProgress" ? error.activeTurnId : null).toBe(first);
      expect((yield* scripted.sent).map((input) => input.text)).toEqual(["first"]);
    }),
  );

  it.effect("treats a repeated send of the active turn as the same turn", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("once"));
      yield* scoped.send(turnId, turn("once"));

      expect((yield* scripted.sent).length).toBe(1);
    }),
  );

  it.effect("frees the turn again when the harness refuses the prompt", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      yield* scripted.refuseSends;

      const error = yield* scoped.send(makeTurnId(), turn("doomed")).pipe(Effect.flip);

      expect(error._tag).toBe("SessionClosed");
      expect(yield* scoped.activeTurnId).toBeNull();
    }),
  );

  it.effect("synthesizes a failed completion when the stream ends mid-turn", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("work"));
      yield* scripted.emit(delta());
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      const last = events.at(-1);
      expect(events.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
      expect(last?.type === "turn.completed" ? last.payload : null).toEqual({
        turnId,
        stopReason: "error",
      });
      expect(last?.connectorInstanceId).toBe(connectorInstanceId);
      expect(yield* scoped.activeTurnId).toBeNull();
    }),
  );

  it.effect("settles the turn on a real completion and lets the next one start", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("first"));
      yield* scripted.emit(turnCompleted());
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
      expect(events[0]?.turnId).toBe(turnId);
      expect(yield* scoped.activeTurnId).toBeNull();

      // The stream is finished, but the handle is free again.
      yield* scoped.send(makeTurnId(), turn("second"));
      expect((yield* scripted.sent).length).toBe(2);
    }),
  );

  it.effect("ends the turn before the session when the session dies mid-turn", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("work"));
      yield* scripted.emit(sessionEnded("crashed"));
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      expect(events.map((event) => event.type)).toEqual(["turn.completed", "session.ended"]);
      const completion = events[0];
      expect(completion?.type === "turn.completed" ? completion.payload.stopReason : null).toBe(
        "error",
      );
    }),
  );

  it.effect("reports an interrupted session as an interrupted turn", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });

      yield* scoped.send(makeTurnId(), turn("work"));
      yield* scripted.emit(sessionEnded("interrupted"));
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      const completion = events[0];
      expect(completion?.type === "turn.completed" ? completion.payload.stopReason : null).toBe(
        "interrupted",
      );
    }),
  );
});
