/**
 * The checkpoint reactor end to end: an accepted `thread.checkpoint.restore`
 * records a durable `thread.checkpoint.restored` event and the hook performs
 * the git work; while a turn runs the command is rejected instead.
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
import * as Layer from "effect/Layer";

import type { PlannedEvent } from "../persistence/EventStore";
import { persistenceLayer } from "../../test/layers";
import {
  CheckpointHook,
  CheckpointHookError,
  CheckpointReactor,
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

/** Engine + reactor over in-memory persistence, with a recording hook. */
const stack = (hook: {
  readonly restore: (input: CheckpointRestoreInput) => Effect.Effect<void, CheckpointHookError>;
}) => {
  const persistence = persistenceLayer();
  const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
  const reactor = CheckpointReactor.pipe(
    Layer.provide(
      Layer.mergeAll(
        engine,
        Layer.succeed(
          CheckpointHook,
          CheckpointHook.of({
            capture: () => Effect.succeed(null),
            restore: hook.restore,
            prune: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  return Layer.mergeAll(engine, reactor);
};

describe("CheckpointReactor", () => {
  it.effect("an accepted restore runs the hook off the restored event", () =>
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
});
