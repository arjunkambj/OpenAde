import {
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { TurnId } from "@OpenAde/contracts/ids";
import type { RuntimeEvent } from "@OpenAde/contracts/runtime";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { TurnInput } from "./definition";
import { NotSteerable, SessionClosed } from "./definition";
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

/**
 * A completion as a harness would emit it: numbered with the harness's own turn
 * id, which is never one the server minted.
 */
const turnCompleted = (): { readonly event: RuntimeEvent; readonly harnessTurnId: TurnId } => {
  const harnessTurnId = makeTurnId();
  return {
    event: {
      ...envelope(),
      type: "turn.completed",
      payload: { turnId: harnessTurnId, stopReason: "end_turn" },
    },
    harnessTurnId,
  };
};

const runtimeError = (fatal: boolean): RuntimeEvent => ({
  ...envelope(),
  type: "runtime.error",
  payload: { message: "the harness gave up", fatal },
});

const usageUpdated = (): RuntimeEvent => ({
  ...envelope(),
  type: "usage.updated",
  payload: { turnId: makeTurnId(), input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
});

/**
 * A handle whose harness is the test itself: events go in through `emit`, the
 * prompts that reached `send` come back out through `sent`, and — for a
 * harness that can steer — the messages that reached `steer` through `steered`.
 */
const makeScriptedHandle = (options?: { readonly steerable?: boolean }) =>
  Effect.gen(function* () {
    const queue = yield* makeBoundedEventQueue({ capacity: 64, reserve: 8 });
    const sentRef = yield* Ref.make<ReadonlyArray<TurnInput>>([]);
    const steeredRef = yield* Ref.make<ReadonlyArray<TurnInput>>([]);
    const failSendRef = yield* Ref.make(false);
    const onInterruptRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);

    const handle: SessionHandle = {
      events: queue.events,
      send: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(failSendRef)) {
            return yield* Effect.fail(new SessionClosed({ threadId }));
          }
          yield* Ref.update(sentRef, (all) => [...all, input]);
        }),
      ...(options?.steerable === true
        ? { steer: (input: TurnInput) => Ref.update(steeredRef, (all) => [...all, input]) }
        : {}),
      interrupt: () => Ref.get(onInterruptRef).pipe(Effect.flatMap((run) => run)),
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
      steered: Ref.get(steeredRef),
      refuseSends: Ref.set(failSendRef, true),
      /** What the harness does when the wrapper asks it to stop. */
      onInterrupt: (run: Effect.Effect<void>) => Ref.set(onInterruptRef, run),
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
      yield* scripted.emit(turnCompleted().event);
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
      expect(events[0]?.turnId).toBe(turnId);
      expect(yield* scoped.activeTurnId).toBeNull();
    }),
  );

  it.effect("refuses a turn once the event stream is over", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });

      yield* scoped.send(makeTurnId(), turn("first"));
      yield* scripted.emit(turnCompleted().event);
      yield* scripted.end;
      yield* Stream.runCollect(scoped.events);

      // Nothing is left to settle a turn, so starting one would strand it.
      const error = yield* scoped.send(makeTurnId(), turn("second")).pipe(Effect.flip);
      expect(error._tag).toBe("SessionClosed");
      expect((yield* scripted.sent).map((input) => input.text)).toEqual(["first"]);
      expect(yield* scoped.activeTurnId).toBeNull();
    }),
  );

  it.effect("replaces the harness's turn id inside the payload, not just the envelope", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();
      const completion = turnCompleted();

      yield* scoped.send(turnId, turn("work"));
      yield* scripted.emit(usageUpdated());
      yield* scripted.emit(completion.event);
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      const payloadTurnIds = events.map((event) =>
        event.type === "usage.updated" || event.type === "turn.completed"
          ? event.payload.turnId
          : null,
      );
      expect(payloadTurnIds).toEqual([turnId, turnId]);
      expect(events.map((event) => event.turnId)).toEqual([turnId, turnId]);
      expect(payloadTurnIds).not.toContain(completion.harnessTurnId);
    }),
  );

  it.effect("interrupt returns only once the turn has settled", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();
      const orderRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const note = (what: string) => Ref.update(orderRef, (all) => [...all, what]);

      // The harness acknowledges the interrupt at once and settles later.
      const settle = yield* Deferred.make<void>();
      yield* scripted.onInterrupt(
        Deferred.await(settle).pipe(
          Effect.andThen(note("harness settled")),
          Effect.andThen(scripted.emit(turnCompleted().event)),
          Effect.forkChild,
          Effect.asVoid,
        ),
      );

      const drain = yield* Effect.forkChild(Stream.runCollect(scoped.events));
      yield* scoped.send(turnId, turn("work"));

      const interrupting = yield* scoped
        .interrupt(turnId)
        .pipe(Effect.andThen(note("interrupt returned")), Effect.forkChild);
      yield* Deferred.succeed(settle, undefined);
      yield* Fiber.join(interrupting);

      expect(yield* Ref.get(orderRef)).toEqual(["harness settled", "interrupt returned"]);
      expect(yield* scoped.activeTurnId).toBeNull();

      yield* scripted.end;
      yield* Fiber.join(drain);
    }),
  );

  it.effect("interrupting a turn that already ended is a no-op", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();
      const asked = yield* Ref.make(false);
      yield* scripted.onInterrupt(Ref.set(asked, true));

      yield* scoped.interrupt(turnId);

      expect(yield* Ref.get(asked)).toBe(false);
    }),
  );

  it.effect("ends the turn even when the event stream dies mid-turn", () =>
    Effect.gen(function* () {
      const dying: SessionHandle = {
        ...(yield* makeScriptedHandle()).handle,
        events: Stream.make(delta()).pipe(Stream.concat(Stream.die(new Error("parser exploded")))),
      };
      const scoped = yield* makeTurnScopedHandle(dying, { connectorInstanceId, threadId });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("work"));
      const events = yield* Stream.runCollect(scoped.events);

      expect(events.map((event) => event.type)).toEqual([
        "content.delta",
        "runtime.error",
        "turn.completed",
      ]);
      const failure = events[1];
      expect(failure?.type === "runtime.error" ? failure.payload.fatal : null).toBe(true);
      expect(failure?.type === "runtime.error" ? failure.payload.message : "").toContain(
        "parser exploded",
      );
      const completion = events.at(-1);
      expect(completion?.type === "turn.completed" ? completion.payload : null).toEqual({
        turnId,
        stopReason: "error",
      });
      expect(yield* scoped.activeTurnId).toBeNull();
    }),
  );

  it.effect("settles the turn on a fatal error, without waiting for the stream to end", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      const drain = yield* Effect.forkChild(Stream.runCollect(scoped.events));
      yield* scoped.send(turnId, turn("work"));
      // The harness says the work is over and keeps its pipe open.
      yield* scripted.emit(runtimeError(true));
      yield* scoped.awaitTurn(turnId);

      expect(yield* scoped.activeTurnId).toBeNull();

      yield* scripted.end;
      const events = yield* Fiber.join(drain);
      expect(events.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
      const completion = events.at(-1);
      expect(completion?.type === "turn.completed" ? completion.payload : null).toEqual({
        turnId,
        stopReason: "error",
      });
    }),
  );

  it.effect("leaves the turn running on a non-fatal error", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedHandle();
      const scoped = yield* makeTurnScopedHandle(scripted.handle, {
        connectorInstanceId,
        threadId,
      });
      const turnId = makeTurnId();

      yield* scoped.send(turnId, turn("work"));
      yield* scripted.emit(runtimeError(false));
      yield* scripted.emit(turnCompleted().event);
      yield* scripted.end;

      const events = yield* Stream.runCollect(scoped.events);
      expect(events.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
      expect(events.map((event) => event.turnId)).toEqual([turnId, turnId]);
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

  describe("steer", () => {
    it.effect("delivers into the active turn and leaves it active", () =>
      Effect.gen(function* () {
        const scripted = yield* makeScriptedHandle({ steerable: true });
        const scoped = yield* makeTurnScopedHandle(scripted.handle, {
          connectorInstanceId,
          threadId,
        });
        const turnId = makeTurnId();

        yield* scoped.send(turnId, turn("build it"));
        yield* scoped.steer(turnId, turn("use port 8081"));

        expect((yield* scripted.steered).map((input) => input.text)).toEqual(["use port 8081"]);
        // No new turn: the prompt went to `send` once, and the turn that was
        // running is still the one running.
        expect((yield* scripted.sent).map((input) => input.text)).toEqual(["build it"]);
        expect(yield* scoped.activeTurnId).toBe(turnId);

        // Events after the steer still belong to that same turn.
        yield* scripted.emit(delta());
        yield* scripted.end;
        const events = yield* Stream.runCollect(scoped.events);
        expect(events.find((event) => event.type === "content.delta")?.turnId).toBe(turnId);
      }),
    );

    it.effect("refuses a turn that is not the active one, and changes nothing", () =>
      Effect.gen(function* () {
        const scripted = yield* makeScriptedHandle({ steerable: true });
        const scoped = yield* makeTurnScopedHandle(scripted.handle, {
          connectorInstanceId,
          threadId,
        });
        const turnId = makeTurnId();
        const stale = makeTurnId();

        // Nothing running at all.
        const idle = yield* Effect.flip(scoped.steer(turnId, turn("too early")));
        expect(idle).toBeInstanceOf(NotSteerable);
        expect(yield* scoped.activeTurnId).toBeNull();

        // A turn running, but a different one — the steer was meant for a
        // turn that has already settled.
        yield* scoped.send(turnId, turn("build it"));
        const error = yield* Effect.flip(scoped.steer(stale, turn("too late")));
        expect(error).toBeInstanceOf(NotSteerable);
        expect(error._tag === "NotSteerable" && error.reason).toContain(stale);
        expect(yield* scripted.steered).toEqual([]);
        expect(yield* scoped.activeTurnId).toBe(turnId);
      }),
    );

    it.effect("refuses when the harness cannot steer, and changes nothing", () =>
      Effect.gen(function* () {
        const scripted = yield* makeScriptedHandle();
        const scoped = yield* makeTurnScopedHandle(scripted.handle, {
          connectorInstanceId,
          threadId,
        });
        const turnId = makeTurnId();

        yield* scoped.send(turnId, turn("build it"));
        const error = yield* Effect.flip(scoped.steer(turnId, turn("use port 8081")));
        expect(error).toBeInstanceOf(NotSteerable);
        expect(yield* scoped.activeTurnId).toBe(turnId);
        expect((yield* scripted.sent).map((input) => input.text)).toEqual(["build it"]);
      }),
    );
  });
});
