/**
 * The checkpoint seam W8 fills in.
 *
 * `CheckpointHook` is the service W8's git work implements: `capture` turns a
 * finished turn into a hidden-ref checkpoint summary (or `null` when nothing
 * changed), `restore` checks one out. The default implementation is an
 * explicit no-op so W1's stack runs without git.
 *
 * `CheckpointReactor` wires it to the log: `turn.completed` → capture →
 * `thread.checkpoint.created`; a `thread.checkpoint.restored` event →
 * restore, with failures recorded as `thread.error`.
 */

import { makeEventId } from "@OpenAde/contracts/ids";
import type { ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { OrchestrationEngine } from "./Engine";
import type { ThreadDoc } from "./state";

export class CheckpointHookError extends Data.TaggedError("CheckpointHookError")<{
  readonly message: string;
}> {}

export interface CheckpointCaptureInput {
  readonly thread: ThreadDoc;
  readonly turnId: TurnId;
  readonly workspaceRoot: string;
}

export interface CheckpointRestoreInput {
  readonly thread: ThreadDoc;
  readonly checkpoint: CheckpointSummary;
  readonly workspaceRoot: string;
}

export interface CheckpointPruneInput {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
}

export class CheckpointHook extends Context.Service<
  CheckpointHook,
  {
    readonly capture: (
      input: CheckpointCaptureInput,
    ) => Effect.Effect<CheckpointSummary | null, CheckpointHookError>;
    readonly restore: (input: CheckpointRestoreInput) => Effect.Effect<void, CheckpointHookError>;
    readonly prune: (input: CheckpointPruneInput) => Effect.Effect<void, CheckpointHookError>;
  }
>()("server/orchestration/CheckpointHook") {
  /** No git integration yet — capture reports nothing to record. */
  static readonly noop: Layer.Layer<CheckpointHook> = Layer.succeed(
    CheckpointHook,
    CheckpointHook.of({
      capture: () => Effect.succeed(null),
      prune: () => Effect.void,
      restore: () =>
        Effect.fail(
          new CheckpointHookError({
            message: "checkpoints are not available in this build",
          }),
        ),
    }),
  );
}

export const CheckpointReactor: Layer.Layer<never, never, OrchestrationEngine | CheckpointHook> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine;
      const hook = yield* CheckpointHook;

      const recordError = (threadId: ThreadId, message: string, causedBy: string) =>
        engine.appendThreadEvents(threadId, [
          {
            eventId: makeEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: new Date().toISOString(),
            causationEventId: causedBy as never,
            correlationId: causedBy,
            actor: "system",
            type: "thread.error",
            payload: { message, fatal: false },
          } satisfies PlannedEvent,
        ]);

      const workspaceRootFor = (doc: ThreadDoc) =>
        engine
          .projectDoc(doc.projectId)
          .pipe(Effect.map((project) => project?.workspaceRoot ?? null));

      // A finished turn is a checkpoint point.
      const eventMailbox = yield* engine.subscribeEvents;
      yield* Stream.runForEach(Stream.fromSubscription(eventMailbox), (event) =>
        Effect.gen(function* () {
          if (event.streamKind !== "thread") {
            return;
          }
          // Thread deleted → drop every hidden checkpoint ref under its prefix.
          if (event.type === "thread.deleted") {
            const threadId = event.streamId as ThreadId;
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null) {
              return;
            }
            const workspaceRoot = yield* workspaceRootFor(doc);
            if (workspaceRoot === null) {
              return;
            }
            return yield* hook
              .prune({ threadId, workspaceRoot })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`checkpoint prune failed: ${error.message}`),
                ),
              );
          }
          // The accepted restore command records this event; the git work
          // order is durable, so the reactor runs off the log, not the
          // transient command publication.
          if (event.type === "thread.checkpoint.restored") {
            const threadId = event.streamId as ThreadId;
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted) {
              return;
            }
            const workspaceRoot = yield* workspaceRootFor(doc);
            if (workspaceRoot === null) {
              return;
            }
            return yield* hook
              .restore({ thread: doc, checkpoint: event.payload.checkpoint, workspaceRoot })
              .pipe(
                Effect.catch((error) =>
                  recordError(
                    threadId,
                    `checkpoint restore failed: ${error.message}`,
                    event.eventId,
                  ),
                ),
              );
          }
          if (event.type !== "thread.turn.completed") {
            return;
          }
          const threadId = event.streamId as ThreadId;
          const doc = yield* engine.threadDoc(threadId);
          if (doc === null || doc.deleted) {
            return;
          }
          const workspaceRoot = yield* workspaceRootFor(doc);
          if (workspaceRoot === null) {
            return;
          }
          const summary = yield* hook
            .capture({
              thread: doc,
              turnId: event.payload.turnId,
              workspaceRoot,
            })
            .pipe(
              Effect.catch((error) =>
                recordError(
                  threadId,
                  `checkpoint capture failed: ${error.message}`,
                  event.eventId,
                ).pipe(Effect.as(null)),
              ),
            );
          if (summary === null) {
            return;
          }
          yield* engine.appendThreadEvents(threadId, [
            {
              eventId: makeEventId(),
              streamKind: "thread",
              streamId: threadId,
              occurredAt: new Date().toISOString(),
              causationEventId: event.eventId,
              correlationId: event.eventId,
              actor: "system",
              type: "thread.checkpoint.created",
              payload: { checkpoint: summary },
            } satisfies PlannedEvent,
          ]);
        }).pipe(
          Effect.catch((error) => Effect.logWarning("checkpoint capture reactor failed", error)),
        ),
      ).pipe(Effect.forkScoped);
    }),
  );
