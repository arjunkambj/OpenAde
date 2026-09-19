/**
 * The checkpoint reactor end to end: an accepted `thread.checkpoint.restore`
 * records a durable work order, the hook performs the git work, and only then
 * is the outcome written — `restored` on success, `restore.failed` otherwise.
 * A work order with no outcome is replayed when the reactor is next built.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  makeCheckpointId,
  makeCommandId,
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { CheckpointId } from "@OpenAde/contracts/ids";
import type { Command, CheckpointSummary } from "@OpenAde/contracts/orchestration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { persistenceLayer } from "../../test/layers";
import {
  CheckpointHook,
  CheckpointHookError,
  CheckpointReactor,
  type CheckpointPruneInput,
  type CheckpointRestoreInput,
} from "./CheckpointReactor";
import { OrchestrationEngine } from "./Engine";

const NOW = "2026-01-02T03:04:05.000Z";

const projectId = makeProjectId();
const threadId = makeThreadId();

const createProject: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "project.create",
  projectId,
  name: "demo",
  workspaceRoot: "/repo",
};

const createThread: Command = {
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.create",
  threadId,
  projectId,
  settings: { model: "fake/model" },
};

const turnStart = (text: string): Command => ({
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.turn.start",
  threadId,
  text,
  attachments: [],
  mentions: [],
  queued: false,
});

const restoreCommand = (checkpointId: CheckpointId): Command => ({
  commandId: makeCommandId(),
  createdAt: NOW,
  type: "thread.checkpoint.restore",
  threadId,
  checkpointId,
});

const checkpoint: CheckpointSummary = {
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref: "refs/openade/checkpoints/thread/turn",
  createdAt: NOW,
};

const planned = (type: string, payload: Record<string, unknown>): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    occurredAt: NOW,
    actor: "system",
    type,
    payload,
  }) as PlannedEvent;

interface HookStub {
  readonly restore?: (input: CheckpointRestoreInput) => Effect.Effect<void, CheckpointHookError>;
  readonly prune?: (input: CheckpointPruneInput) => Effect.Effect<void, CheckpointHookError>;
}

/** Engine + reactor over the given persistence, with a recording hook. */
const stackOver = (persistence: ReturnType<typeof persistenceLayer>, hook: HookStub) => {
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const reactor = CheckpointReactor.pipe(
    Layer.provide(
      Layer.mergeAll(
        engine,
        Layer.succeed(
          CheckpointHook,
          CheckpointHook.of({
            capture: () => Effect.succeed(null),
            restore: hook.restore ?? (() => Effect.void),
            prune: hook.prune ?? (() => Effect.void),
          }),
        ),
        persistence,
      ),
    ),
  );
  return Layer.mergeAll(engine, reactor);
};

/** The common case: one fresh in-memory database per test. */
const stack = (hook: HookStub) => stackOver(persistenceLayer(), hook);

describe("CheckpointReactor", () => {
  it.effect("an accepted restore runs the hook off the work order", () =>
    Effect.gen(function* () {
      const restored = yield* Deferred.make<CheckpointRestoreInput>();
      const layer = stack({
        restore: (input) => Deferred.succeed(restored, input).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.checkpoint.created", { checkpoint }),
        ]);

        const receipt = yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        expect(receipt.status).toBe("accepted");

        const input = yield* Deferred.await(restored).pipe(Effect.timeout("5 seconds"));
        expect(input.checkpoint.checkpointId).toBe(checkpoint.checkpointId);
        expect(input.workspaceRoot).toBe("/repo");

        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.snapshotSequence).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("records the outcome only after the git work finishes", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>();
      const layer = stack({ restore: () => Effect.void });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.checkpoint.created", { checkpoint }),
        ]);
        yield* Stream.runForEach(engine.events, (entry) =>
          entry.type.startsWith("thread.checkpoint.restore")
            ? Queue.offer(events, entry.type)
            : Effect.void,
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        expect(yield* Queue.take(events).pipe(Effect.timeout("5 seconds"))).toBe(
          "thread.checkpoint.restore.requested",
        );
        expect(yield* Queue.take(events).pipe(Effect.timeout("5 seconds"))).toBe(
          "thread.checkpoint.restored",
        );
        expect((yield* engine.threadDoc(threadId))?.restoring).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a failed restore records the failure, not a success", () =>
    Effect.gen(function* () {
      const layer = stack({
        restore: () => Effect.fail(new CheckpointHookError({ message: "index.lock exists" })),
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.checkpoint.created", { checkpoint }),
        ]);
        const failed = yield* Stream.runHead(
          engine.events.pipe(
            Stream.filter((entry) => entry.type === "thread.checkpoint.restore.failed"),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        const entry = yield* Fiber.join(failed).pipe(Effect.timeout("5 seconds"));
        expect(Option.isSome(entry)).toBe(true);
        if (Option.isSome(entry)) {
          const payload = entry.value.payload as { checkpointId: string; message: string };
          expect(payload.checkpointId).toBe(checkpoint.checkpointId);
          expect(payload.message).toContain("index.lock");
        }

        // Nothing claimed success, and the thread is usable again.
        const doc = yield* engine.threadDoc(threadId);
        expect(doc?.restoring).toBe(false);
        expect(doc?.status).not.toBe("error");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("replays a work order the last process never acted on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // One database, two reactor builds — the second is the next boot.
        const persistence = Layer.succeedContext(yield* Layer.build(persistenceLayer()));

        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          yield* engine.dispatch(createProject);
          yield* engine.dispatch(createThread);
          yield* engine.appendThreadEvents(threadId, [
            planned("thread.checkpoint.created", { checkpoint }),
            planned("thread.checkpoint.restore.requested", { checkpoint }),
          ]);
          expect((yield* engine.threadDoc(threadId))?.restoring).toBe(true);
        }).pipe(Effect.provide(OrchestrationEngine.layer.pipe(Layer.provide(persistence))));

        const restored = yield* Deferred.make<CheckpointRestoreInput>();
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngine;
          const input = yield* Deferred.await(restored).pipe(Effect.timeout("5 seconds"));
          expect(input.checkpoint.checkpointId).toBe(checkpoint.checkpointId);
          yield* Stream.runHead(
            engine.events.pipe(
              Stream.filter((entry) => entry.type === "thread.checkpoint.restored"),
            ),
          ).pipe(Effect.timeout("5 seconds"));
          expect((yield* engine.threadDoc(threadId))?.restoring).toBe(false);
        }).pipe(
          Effect.provide(
            stackOver(persistence, {
              restore: (input) => Deferred.succeed(restored, input).pipe(Effect.asVoid),
            }),
          ),
        );
      }),
    ),
  );

  it.effect("restore is rejected while a turn is running", () =>
    Effect.gen(function* () {
      const calls: Array<CheckpointRestoreInput> = [];
      const layer = stack({
        restore: (input) => Effect.sync(() => calls.push(input)),
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.checkpoint.created", { checkpoint }),
        ]);

        // Turn requested → currentTurn set → restore must not run.
        yield* engine.dispatch(turnStart("work"));
        const rejected = yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        expect(rejected.status).toBe("rejected");
        expect(rejected.reason).toContain("running turn");
        expect(calls).toHaveLength(0);

        // Once the turn settles, the same command is accepted again.
        const doc = yield* engine.threadDoc(threadId);
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.turn.completed", {
            turnId: doc!.currentTurn!.turnId,
            stopReason: "end_turn",
          }),
        ]);
        const accepted = yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        expect(accepted.status).toBe("accepted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a restore locks out the whole project, not just its own thread", () =>
    Effect.gen(function* () {
      const sibling = makeThreadId();
      const running = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = stack({
        restore: () =>
          Deferred.succeed(running, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId: sibling,
          projectId,
          settings: { model: "fake/model" },
        });
        yield* engine.appendThreadEvents(threadId, [
          planned("thread.checkpoint.created", { checkpoint }),
        ]);

        yield* engine.dispatch(restoreCommand(checkpoint.checkpointId));
        // The git work has started and is holding the worktree.
        yield* Deferred.await(running).pipe(Effect.timeout("5 seconds"));

        // `git clean -fd` runs over the project's whole workspace root, so a
        // sibling thread's turn would have its files deleted underneath it.
        const turn = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.turn.start",
          threadId: sibling,
          text: "work",
          attachments: [],
          mentions: [],
          queued: false,
        });
        expect(turn.status).toBe("rejected");
        expect(turn.reason).toContain("another thread in project");

        // And so would a second restore in the same repository.
        const second = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.checkpoint.restore",
          threadId: sibling,
          checkpointId: checkpoint.checkpointId,
        });
        expect(second.status).toBe("rejected");
        expect(second.reason).toContain("another thread in project");

        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("thread.delete prunes the deleted thread's checkpoint prefix", () =>
    Effect.gen(function* () {
      const pruned = yield* Queue.unbounded<CheckpointPruneInput>();
      const layer = stack({ prune: (input) => Queue.offer(pruned, input).pipe(Effect.asVoid) });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);

        const receipt = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId,
        });
        expect(receipt.status).toBe("accepted");

        // The delete removed the read-model row inside its own transaction,
        // so the prune has to find the worktree in the log instead.
        const input = yield* Queue.take(pruned).pipe(Effect.timeout("5 seconds"));
        expect(input.threadId).toBe(threadId);
        expect(input.workspaceRoot).toBe("/repo");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("project.removed prunes every thread's checkpoint prefix", () =>
    Effect.gen(function* () {
      const secondThread = makeThreadId();
      const pruned = yield* Queue.unbounded<CheckpointPruneInput>();
      const layer = stack({
        prune: (input) => Queue.offer(pruned, input).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine;
        yield* engine.dispatch(createProject);
        yield* engine.dispatch(createThread);
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId: secondThread,
          projectId,
          settings: { model: "fake/model" },
        });

        const receipt = yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "project.remove",
          projectId,
        });
        expect(receipt.status).toBe("accepted");

        // Both threads' prefixes are pruned against the project's root even
        // though the removal deleted their read-model rows first.
        const seen = [
          yield* Queue.take(pruned).pipe(Effect.timeout("5 seconds")),
          yield* Queue.take(pruned).pipe(Effect.timeout("5 seconds")),
        ];
        expect(new Set(seen.map((input) => input.threadId))).toEqual(
          new Set([threadId, secondThread]),
        );
        expect(seen.every((input) => input.workspaceRoot === "/repo")).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );
});
