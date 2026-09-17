/**
 * The checkpoint seam W8 fills in.
 *
 * `CheckpointHook` is the service W8's git work implements: `capture` turns a
 * finished turn into a hidden-ref checkpoint summary (or `null` when nothing
 * changed), `restore` checks one out. The default implementation is an
 * explicit no-op so W1's stack runs without git.
 *
 * `CheckpointReactor` wires it to the log: `turn.completed` → capture →
 * `thread.checkpoint.created`; a `thread.checkpoint.restore.requested` work
 * order → the git work → `thread.checkpoint.restored` or
 * `thread.checkpoint.restore.failed`, never before. Work orders with no
 * outcome recorded are replayed at layer build, so a crash between the
 * accepted command and the git work cannot drop the restore. Thread deletion
 * and project removal each prune the hidden refs under the thread's prefix —
 * the project case enumerates the thread streams, because the removal's
 * transaction has already deleted the read-model rows.
 */

import { makeEventId } from "@OpenAde/contracts/ids";
import type { ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary, OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { EventStore } from "../persistence/EventStore";
import { OrchestrationEngine, type EngineError } from "./Engine";
import { foldProject, foldThread, type ThreadDoc } from "./state";

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

export const CheckpointReactor: Layer.Layer<
  never,
  never,
  OrchestrationEngine | CheckpointHook | EventStore
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const hook = yield* CheckpointHook;
    const store = yield* EventStore;

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

    const settle = (
      threadId: ThreadId,
      type: "thread.checkpoint.restored" | "thread.checkpoint.restore.failed",
      payload: OrchestrationEvent["payload"],
      causedBy: string,
    ) =>
      engine.appendThreadEvents(threadId, [
        {
          eventId: makeEventId(),
          streamKind: "thread",
          streamId: threadId,
          occurredAt: new Date().toISOString(),
          causationEventId: causedBy as never,
          correlationId: causedBy,
          actor: "system",
          type,
          payload,
        } as PlannedEvent,
      ]);

    /**
     * One restore at a time, whatever fiber asks for it. The decider already
     * excludes a second restore in the same project, but the boot replay runs
     * on its own fiber beside the live subscription — this is what keeps two
     * `git restore`/`git clean -fd` pairs out of one repository even so.
     */
    const restoreMutex = yield* Semaphore.make(1);

    /**
     * The git work for one accepted restore, and the durable record of how it
     * went. `restored` is written only after git succeeded — a client that
     * folded the work order sees the thread leave `restoring` either way.
     */
    const restoreOnce = (
      threadId: ThreadId,
      checkpoint: CheckpointSummary,
      causedBy: string,
    ): Effect.Effect<void, EngineError> =>
      Effect.gen(function* () {
        const doc = yield* engine.threadDoc(threadId);
        if (doc === null || doc.deleted) {
          return;
        }
        const workspaceRoot = yield* workspaceRootFor(doc);
        if (workspaceRoot === null) {
          yield* settle(
            threadId,
            "thread.checkpoint.restore.failed",
            { checkpointId: checkpoint.checkpointId, message: "the project no longer exists" },
            causedBy,
          );
          return;
        }
        const failure = yield* hook.restore({ thread: doc, checkpoint, workspaceRoot }).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        yield* failure === null
          ? settle(threadId, "thread.checkpoint.restored", { checkpoint }, causedBy)
          : settle(
              threadId,
              "thread.checkpoint.restore.failed",
              { checkpointId: checkpoint.checkpointId, message: failure },
              causedBy,
            );
      });

    /** Work orders this process has already acted on — see `runRestore`. */
    const handled = yield* Ref.make<ReadonlySet<string>>(new Set());

    /**
     * One run per work order, whichever path reaches it first. The replay list
     * is read before the live loop starts, so the two cannot claim the same
     * order — this is the backstop that makes that true by construction rather
     * than by the ordering of two fibers.
     */
    const runRestore = (
      threadId: ThreadId,
      checkpoint: CheckpointSummary,
      causedBy: string,
    ): Effect.Effect<void, EngineError> =>
      restoreMutex.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(handled)).has(causedBy)) {
            return;
          }
          yield* Ref.update(handled, (seen) => new Set(seen).add(causedBy));
          yield* restoreOnce(threadId, checkpoint, causedBy);
        }),
      );

    // A finished turn is a checkpoint point.
    const eventMailbox = yield* engine.subscribeEvents;

    /**
     * A restore accepted before the last shutdown: the work order is in the
     * log with no `restored`/`restore.failed` after it, so nothing has touched
     * the worktree yet.
     *
     * The list is read here, during the layer build, and only the git work is
     * forked: a work order accepted after this read cannot be in it, so the
     * live subscription below owns that one alone. Reading it on the forked
     * fiber instead would let an order published in the meantime be both
     * queued in the mailbox and still outcome-less in the log — two `git
     * restore`/`git clean -fd` runs and two outcomes for one order.
     */
    const pendingRestores = Effect.gen(function* () {
      const events = yield* store.threadEventsAfter(0);
      const pending = new Map<ThreadId, OrchestrationEvent>();
      for (const entry of events) {
        const threadId = entry.streamId as ThreadId;
        if (entry.type === "thread.checkpoint.restore.requested") {
          pending.set(threadId, entry);
        } else if (
          entry.type === "thread.checkpoint.restored" ||
          entry.type === "thread.checkpoint.restore.failed" ||
          entry.type === "thread.deleted"
        ) {
          pending.delete(threadId);
        }
      }
      return [...pending.values()];
    });

    const pending = yield* pendingRestores.pipe(
      Effect.catch((error) =>
        Effect.logWarning("checkpoint restore replay could not read the log", error).pipe(
          Effect.as([] as ReadonlyArray<OrchestrationEvent>),
        ),
      ),
    );
    // Only the git work is forked: it must not hold up the layer build, and
    // each thread stays `restoring` (and so unusable for turns) until its own
    // replay finishes.
    yield* Effect.forEach(pending, (entry) =>
      runRestore(
        entry.streamId as ThreadId,
        (entry.payload as { readonly checkpoint: CheckpointSummary }).checkpoint,
        entry.eventId,
      ),
    ).pipe(
      Effect.catch((error) => Effect.logWarning("checkpoint restore replay failed", error)),
      Effect.forkScoped,
    );
    yield* Stream.runForEach(Stream.fromSubscription(eventMailbox), (event) =>
      Effect.gen(function* () {
        // Project removed → every thread's checkpoint prefix goes. The
        // removal's transaction already deleted the thread rows, so the
        // enumeration reads the event log, not the read model.
        if (event.streamKind === "project" && event.type === "project.removed") {
          const projectId = event.payload.projectId;
          const projectDoc = foldProject(yield* store.loadStream("project", projectId));
          if (projectDoc === null) {
            return;
          }
          const threadEvents = yield* store.threadEventsAfter(0);
          const threadIds = new Set<ThreadId>();
          for (const entry of threadEvents) {
            if (entry.type === "thread.created" && entry.payload.projectId === projectId) {
              threadIds.add(entry.streamId as ThreadId);
            }
          }
          for (const threadId of threadIds) {
            yield* hook
              .prune({ threadId, workspaceRoot: projectDoc.workspaceRoot })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`checkpoint prune failed: ${error.message}`),
                ),
              );
          }
          return;
        }
        if (event.streamKind !== "thread") {
          return;
        }
        // Thread deleted → drop every hidden checkpoint ref under its prefix.
        // The delete's transaction removed the read-model row before this
        // event was published, so the thread's project — and with it the
        // worktree the refs live in — comes from the log, not `threadDoc`.
        if (event.type === "thread.deleted") {
          const threadId = event.streamId as ThreadId;
          const doc = foldThread(yield* store.loadStream("thread", threadId));
          if (doc === null) {
            return;
          }
          const projectDoc = foldProject(yield* store.loadStream("project", doc.projectId));
          if (projectDoc === null) {
            return;
          }
          const workspaceRoot = projectDoc.workspaceRoot;
          return yield* hook
            .prune({ threadId, workspaceRoot })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(`checkpoint prune failed: ${error.message}`),
              ),
            );
        }
        // The accepted restore command records the work order; the reactor
        // runs off the log, not the transient command publication, so a crash
        // before this point is replayed at the next boot instead of lost.
        if (event.type === "thread.checkpoint.restore.requested") {
          return yield* runRestore(
            event.streamId as ThreadId,
            event.payload.checkpoint,
            event.eventId,
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
