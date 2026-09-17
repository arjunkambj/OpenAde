/**
 * The client fold is a projection of the server's fold — these tests pin the
 * places the two must agree.
 */

import { describe, expect, it } from "@effect/vitest";
import {
  makeCheckpointId,
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { OrchestrationEvent, ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { applyThreadEvent, applyThreadListItem, applyThreadStreamItem } from "./clientState";

const threadId = makeThreadId();

const snapshot = (): ThreadDetailSnapshot => ({
  threadId,
  projectId: makeProjectId(),
  title: "test",
  status: "running",
  settings: {
    model: "fake/model",
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
  },
  snapshotSequence: 1,
  items: [],
  queue: [],
  checkpoints: [],
  session: null,
  currentTurnId: null,
  pendingApproval: null,
  pendingUserInput: null,
  pendingPlan: null,
  usage: null,
  context: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

let sequence = 1;
const event = (
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
): OrchestrationEvent =>
  ({
    eventId: makeEventId(),
    type,
    sequence: (sequence += 1),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "connector",
    payload,
  }) as OrchestrationEvent;

describe("clientState fold", () => {
  it("keeps pendingPlan across turn completion until plan.responded", () => {
    const turnId = makeTurnId();
    let doc = applyThreadEvent(
      snapshot(),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
    );
    expect(doc.pendingPlan?.turnId).toBe(turnId);

    // Plans are answered after the turn ends — completing the turn must not
    // take the card down.
    doc = applyThreadEvent(doc, event("thread.turn.completed", { turnId, stopReason: "end_turn" }));
    expect(doc.status).toBe("idle");
    expect(doc.currentTurnId).toBeNull();
    expect(doc.pendingPlan?.turnId).toBe(turnId);

    doc = applyThreadEvent(doc, event("thread.plan.responded", { turnId, action: "accept" }));
    expect(doc.pendingPlan).toBeNull();
  });

  it("keeps pendingPlan across turn interruption", () => {
    const turnId = makeTurnId();
    let doc = applyThreadEvent(
      snapshot(),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
    );
    doc = applyThreadEvent(doc, event("thread.turn.interrupted", { turnId }));
    expect(doc.pendingPlan?.turnId).toBe(turnId);
  });

  it("ignores plan.responded for a different turn", () => {
    const turnId = makeTurnId();
    const doc = applyThreadEvent(
      applyThreadEvent(
        snapshot(),
        event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      ),
      event("thread.plan.responded", { turnId: makeTurnId(), action: "accept" }),
    );
    expect(doc.pendingPlan?.turnId).toBe(turnId);
  });

  it("distinguishes a deleted thread from an archived one", () => {
    const archived = applyThreadEvent(snapshot(), event("thread.archived", {}));
    expect(archived.status).toBe("archived");

    // A thread deleted from another window must not look merely filed away:
    // the route reads this status to leave the timeline.
    const deleted = applyThreadEvent(snapshot(), event("thread.deleted", {}));
    expect(deleted.status).toBe("deleted");
    expect(deleted.currentTurnId).toBeNull();
  });

  it("tracks a checkpoint restore from order to outcome", () => {
    // The server's own `restoring` flag is not on the wire, so these three
    // events are the only way the pane can tell "queued" from "running" from
    // "git refused it".
    const checkpoint = {
      checkpointId: makeCheckpointId(),
      turnId: makeTurnId(),
      ref: "refs/openade/checkpoints/1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const ordered = applyThreadEvent(
      snapshot(),
      event("thread.checkpoint.restore.requested", { checkpoint }),
    );
    expect(ordered.restoring).toEqual(checkpoint);
    expect(ordered.restoreFailure).toBeNull();

    const failed = applyThreadEvent(
      ordered,
      event("thread.checkpoint.restore.failed", {
        checkpointId: checkpoint.checkpointId,
        message: "worktree has uncommitted changes",
      }),
    );
    // No longer running, and the reason git gave outlives the event — it is
    // the only place the user can ever read it.
    expect(failed.restoring).toBeNull();
    expect(failed.restoreFailure).toEqual({
      checkpointId: checkpoint.checkpointId,
      message: "worktree has uncommitted changes",
    });

    // Retrying clears the stale error the moment the new order is accepted,
    // rather than leaving it up beside a running restore.
    const retried = applyThreadEvent(
      failed,
      event("thread.checkpoint.restore.requested", { checkpoint }),
    );
    expect(retried.restoreFailure).toBeNull();

    const restored = applyThreadEvent(retried, event("thread.checkpoint.restored", { checkpoint }));
    expect(restored.restoring).toBeNull();
    expect(restored.restoreFailure).toBeNull();
  });

  it("carries a running restore across a re-subscribe but not across a resnapshot", () => {
    const checkpoint = {
      checkpointId: makeCheckpointId(),
      turnId: makeTurnId(),
      ref: "refs/openade/checkpoints/1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const restoring = applyThreadEvent(
      snapshot(),
      event("thread.checkpoint.restore.requested", { checkpoint }),
    );

    // The stream repeats after a clean close; the server's snapshot says
    // nothing about the restore, so re-reading it must not blank the spinner.
    const resubscribed = applyThreadStreamItem(restoring, {
      kind: "snapshot",
      snapshot: snapshot(),
    });
    expect(resubscribed?.restoring).toEqual(checkpoint);

    // `resnapshot-required` drops the doc first, and a client with no history
    // genuinely does not know whether the restore is still running.
    const cold = applyThreadStreamItem(null, { kind: "snapshot", snapshot: snapshot() });
    expect(cold?.restoring ?? null).toBeNull();
  });

  it("clears the thread list when the server asks for a resnapshot", () => {
    const threads = applyThreadListItem([], {
      kind: "snapshot",
      snapshotSequence: 3,
      threads: [
        {
          threadId,
          projectId: makeProjectId(),
          title: "one",
          status: "idle",
          settings: {
            model: "fake/model",
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
          },
          awaitingInput: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(threads.length).toBe(1);

    // Keeping the old rows would leave a list that silently stopped updating.
    expect(applyThreadListItem(threads, { kind: "resnapshot-required", reason: "budget" })).toEqual(
      [],
    );
  });
});
