/**
 * The suite every connector has to pass.
 *
 * The orchestration engine is written against five promises, and it is written
 * against them for every connector at once. A connector that breaks one does
 * not fail loudly — it strands a thread, or leaks a process, or leaves an
 * approval card on screen forever. So the promises are executable, and a new
 * connector's test file is one call to `runConnectorConformance`:
 *
 *  1. A session announces itself before it reports any work.
 *  2. Every turn completes exactly once.
 *  3. Every approval request it opens is eventually resolved.
 *  4. Nothing about the work is emitted after `close`.
 *  5. `close` proves the process tree is gone.
 *
 * A sixth case rides along: every event the connector did emit is encoded back
 * through the `RuntimeEvent` schema, so a payload that only looks right fails
 * here rather than at the transport. It proves nothing about coverage of the
 * vocabulary — a connector that emits three event types passes it — and its
 * name says so.
 *
 * The suite drives the real definition — `createInstance`, `startSession`,
 * `send`, `close` — and never inspects anything a connector did not put on the
 * event stream. `isProcessGone` is the one hook it needs from outside, because
 * proof that a process tree is gone cannot come from the stream by definition.
 */

import { RuntimeEvent } from "@poseidon/contracts/runtime";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ConnectorDefinition,
  ConnectorServices,
  StartSessionInput,
  TurnInput,
} from "./definition";
import { makeStreamCollector } from "./streamCollector";

export interface ConnectorConformanceOptions<Config> {
  readonly instanceId: ConnectorInstanceId;
  readonly services: ConnectorServices;
  /** Defaults to `definition.defaultConfig()`. */
  readonly config?: Config;
  readonly session: StartSessionInput;
  /** A turn that does some ordinary work and finishes. */
  readonly turn: TurnInput;
  /**
   * A turn that makes this harness open an approval request. Connectors that
   * cannot be made to ask for permission on demand leave it out, and the
   * request-resolution case is skipped for them.
   */
  readonly approvalTurn?: TurnInput;
  /** Whether the process tree started for this thread is gone. */
  readonly isProcessGone: (threadId: ThreadId) => Effect.Effect<boolean>;
}

const isCompletion = (event: RuntimeEvent): boolean => event.type === "turn.completed";

/**
 * Anything that is the session already working. Opening an approval or starting
 * a turn counts: a connector that asks for permission, or announces a turn,
 * before it has said which session it is has already broken the promise, and a
 * check that looked only at items and deltas let both through.
 */
const isWorkEvent = (event: RuntimeEvent): boolean =>
  event.type.startsWith("item.") ||
  event.type.startsWith("task.") ||
  event.type === "content.delta" ||
  event.type === "request.opened" ||
  event.type === "user-input.requested" ||
  event.type === "turn.started";

const completionTurnId = (event: RuntimeEvent): string | null =>
  event.type === "turn.completed" ? event.payload.turnId : null;

const validateEvent = Schema.encodeEffect(RuntimeEvent);

export const runConnectorConformance = <Config>(
  definition: ConnectorDefinition<Config>,
  options: ConnectorConformanceOptions<Config>,
): void => {
  const open = Effect.gen(function* () {
    const instance = yield* definition.createInstance({
      instanceId: options.instanceId,
      config: options.config ?? definition.defaultConfig(),
      services: options.services,
    });
    const handle = yield* instance.startSession(options.session);
    const collector = yield* makeStreamCollector(handle.events);
    return { instance, handle, collector };
  });

  describe(`${definition.metadata.displayName} connector conformance`, () => {
    it.effect("announces the session before it reports any work", () =>
      Effect.gen(function* () {
        const { handle, collector } = yield* open;

        yield* handle.send(options.turn);
        yield* collector.awaitItem(isCompletion);
        const events = yield* collector.collected;

        const announced = events.findIndex((event) => event.type === "session.started");
        const firstWork = events.findIndex(isWorkEvent);
        expect(announced).toBeGreaterThanOrEqual(0);
        if (firstWork >= 0) {
          expect(announced).toBeLessThan(firstWork);
        }

        yield* handle.close();
      }),
    );

    it.effect("encodes every event it emits back onto the wire", () =>
      Effect.gen(function* () {
        const { handle, collector } = yield* open;

        yield* handle.send(options.turn);
        yield* collector.awaitItem(isCompletion);
        const events = yield* collector.collected;

        // `awaitItem` above already guarantees at least the completion.
        yield* Effect.forEach(events, (event) => validateEvent(event));

        yield* handle.close();
      }),
    );

    it.effect("completes each turn exactly once", () =>
      Effect.gen(function* () {
        const { handle, collector } = yield* open;

        yield* handle.send(options.turn);
        const first = yield* collector.awaitItem(isCompletion);
        yield* handle.send(options.turn);
        yield* collector.awaitItem(
          (event) => isCompletion(event) && event.eventId !== first.eventId,
        );

        const completions = (yield* collector.collected).filter(isCompletion);
        expect(completions.length).toBe(2);
        expect(new Set(completions.map(completionTurnId)).size).toBe(2);

        yield* handle.close();
      }),
    );

    if (options.approvalTurn !== undefined) {
      const approvalTurn = options.approvalTurn;
      it.effect("resolves every approval request it opens", () =>
        Effect.gen(function* () {
          const { handle, collector } = yield* open;

          yield* handle.send(approvalTurn);
          const opened = yield* collector.awaitItem((event) => event.type === "request.opened");
          if (opened.type !== "request.opened") {
            throw new Error("collector returned the wrong event");
          }
          const requestId = opened.payload.request.requestId;
          yield* handle.respondToRequest(requestId, "allow-once");
          yield* collector.awaitItem(
            (event) => event.type === "request.resolved" && event.payload.requestId === requestId,
          );
          yield* collector.awaitItem(isCompletion);

          const events = yield* collector.collected;
          const openedIds = events.flatMap((event) =>
            event.type === "request.opened" ? [event.payload.request.requestId] : [],
          );
          const resolvedIds = new Set(
            events.flatMap((event) =>
              event.type === "request.resolved" ? [event.payload.requestId] : [],
            ),
          );
          expect(openedIds.length).toBeGreaterThan(0);
          expect(openedIds.filter((id) => !resolvedIds.has(id))).toEqual([]);

          yield* handle.close();
        }),
      );
    }

    it.effect("says nothing more about the work once it is closed", () =>
      Effect.gen(function* () {
        const { handle, collector } = yield* open;

        yield* handle.send(options.turn);
        yield* collector.awaitItem(isCompletion);
        const seenBeforeClose = (yield* collector.collected).length;

        yield* handle.close();
        yield* collector.awaitDone;

        const tail = (yield* collector.collected).slice(seenBeforeClose);
        expect(tail.filter((event) => !event.type.startsWith("session."))).toEqual([]);
        expect(yield* collector.isDone).toBe(true);
      }),
    );

    it.effect("proves the process is gone when it closes", () =>
      Effect.gen(function* () {
        const { handle } = yield* open;

        expect(yield* options.isProcessGone(options.session.threadId)).toBe(false);
        yield* handle.close();
        expect(yield* options.isProcessGone(options.session.threadId)).toBe(true);
      }),
    );
  });
};
