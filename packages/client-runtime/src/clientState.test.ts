/**
 * The client fold is a projection of the server's fold — these tests pin the
 * places the two must agree.
 */

import { describe, expect, it } from "@effect/vitest";
import { makeEventId, makeProjectId, makeThreadId, makeTurnId } from "@OpenAde/contracts/ids";
import type { OrchestrationEvent, ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { applyThreadEvent } from "./clientState";

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
});
