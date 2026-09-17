/**
 * The session supervisor: nothing outlives a restart on purpose.
 *
 * On boot it scans the thread read model. A thread mid-turn or waiting on
 * input whose session vanished gets `thread.session.lost`; a thread still
 * bound to a `sessionRef` gets a `resumeSession` attempt with exponential
 * backoff — after the attempts run out the thread is marked `session.lost`
 * rather than left wedged.
 *
 * While running it watches the lifecycle channel: a `crashed` end starts the
 * same resume loop. A `stopped` end is deliberate and restarts nothing.
 */

import { makeEventId } from "@OpenAde/contracts/ids";
import type { ThreadId } from "@OpenAde/contracts/ids";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { OrchestrationEngine, type EngineError } from "./Engine";
import { SessionManager } from "./SessionManager";
import type { ThreadDoc } from "./state";

export interface SupervisorOptions {
  /** Resume attempts before giving up and writing `session.lost`. */
  readonly maxAttempts?: number;
  /** First backoff step, in milliseconds; doubles per attempt. `0` disables sleep. */
  readonly baseDelayMillis?: number;
}

const sessionLost = (threadId: ThreadId, reason: string): PlannedEvent => ({
  eventId: makeEventId(),
  streamKind: "thread",
  streamId: threadId,
  occurredAt: new Date().toISOString(),
  actor: "system",
  type: "thread.session.lost",
  payload: { reason },
});

/**
 * A crash the user can see. Without it the answer just stops mid-sentence and
 * the thread goes back to idle with nothing in the timeline to explain why:
 * `session.ended` maps to no event, and a stream that merely ends produces
 * only a synthesized `turn.completed`.
 */
const crashNotice = (threadId: ThreadId): PlannedEvent => ({
  eventId: makeEventId(),
  streamKind: "thread",
  streamId: threadId,
  occurredAt: new Date().toISOString(),
  actor: "system",
  type: "thread.error",
  payload: { message: "the agent process exited unexpectedly; reconnecting", fatal: false },
});

export const makeSessionSupervisor = (
  options: SupervisorOptions = {},
): Layer.Layer<never, never, OrchestrationEngine | SessionManager> => {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelay = options.baseDelayMillis ?? 250;

  return Layer.effectDiscard(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const sessions = yield* SessionManager;

      /** Fresh doc read each pass — a deleted/archived thread stops the loop. */
      const resumeLoop = (threadId: ThreadId, attempt: number): Effect.Effect<void, EngineError> =>
        Effect.gen(function* () {
          const doc = yield* engine.threadDoc(threadId);
          if (doc === null || doc.deleted || doc.status === "archived" || doc.session === null) {
            return;
          }
          const live = yield* sessions.handleFor(threadId);
          if (live !== null) {
            return;
          }
          const project = yield* engine.projectDoc(doc.projectId);
          if (project === null) {
            return;
          }
          const resumed = yield* sessions.ensure(doc, project.workspaceRoot).pipe(
            Effect.as(true),
            // The thread gets `session.lost` when attempts run out — the log
            // is where it finds out why, so every failed attempt is recorded.
            Effect.catch((error) =>
              Effect.logWarning(
                `session resume attempt ${attempt + 1} of ${maxAttempts} failed for thread ${threadId}`,
                error,
              ).pipe(Effect.as(false)),
            ),
          );
          if (resumed) {
            return;
          }
          if (attempt + 1 >= maxAttempts) {
            yield* engine.appendThreadEvents(threadId, [
              sessionLost(threadId, `session could not be resumed after ${maxAttempts} attempts`),
            ]);
            return;
          }
          if (baseDelay > 0) {
            yield* Effect.sleep(baseDelay * 2 ** attempt);
          }
          yield* resumeLoop(threadId, attempt + 1);
        });

      /**
       * Boot scan: running/waiting threads and any with a bound session. An
       * archived thread is never one of them — `resumeLoop` bails on it
       * anyway, so counting it here only made the two disagree.
       */
      const needsAttention = (doc: ThreadDoc): boolean =>
        doc.status !== "archived" &&
        (doc.status === "running" || doc.status === "waiting" || doc.session !== null);

      // The scan runs inline during layer build: at real boot the database is
      // the only state that exists, so `running + no session` genuinely means
      // lost. Forking it would let live dispatches interleave and mark a
      // healthy thread as lost.
      const supervisorScope = yield* Effect.scope;
      yield* Effect.gen(function* () {
        const docs = yield* engine.threadDocs;
        for (const doc of docs) {
          if (doc.deleted || !needsAttention(doc)) {
            continue;
          }
          if (doc.session === null) {
            yield* engine.appendThreadEvents(doc.threadId, [
              sessionLost(doc.threadId, "session state was unavailable after restart"),
            ]);
            continue;
          }
          // Resume attempts run on fibers — a slow connector must not hold the
          // rest of the build.
          yield* Effect.forkIn(resumeLoop(doc.threadId, 0), supervisorScope);
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("boot resume scan failed", error)));

      yield* Stream.runForEach(sessions.lifecycle, (entry) =>
        entry.kind === "ended" && entry.reason === "crashed"
          ? engine
              .appendThreadEvents(entry.threadId, [crashNotice(entry.threadId)])
              .pipe(Effect.andThen(resumeLoop(entry.threadId, 0)))
          : Effect.void,
      ).pipe(Effect.forkScoped);
    }),
  );
};
