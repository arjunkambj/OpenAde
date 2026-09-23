/**
 * The thread fold, driven straight from event sequences.
 *
 * Every case here is a state the decider later reads back — a fold that gets
 * one of them wrong wedges a thread rather than merely showing it wrong.
 */

import { describe, expect, it } from "vitest";

import {
  makeCheckpointId,
  makeConnectorInstanceId,
  makeEventId,
  makeItemId,
  makeProjectId,
  makeRequestId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import { UNANSWERED_OUTCOME } from "@OpenAde/contracts/decisions";
import type { CheckpointSummary, OrchestrationEvent } from "@OpenAde/contracts/orchestration";

import {
  foldThread,
  projectThreadEvent,
  threadSnapshotOf,
  threadSummaryOf,
  type ThreadDoc,
} from "./state";

const NOW = "2026-01-02T03:04:05.000Z";

const projectId = makeProjectId();
const threadId = makeThreadId();

let sequence = 0;

const event = <Type extends OrchestrationEvent["type"]>(
  type: Type,
  payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
): OrchestrationEvent => {
  sequence += 1;
  return {
    sequence,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: sequence,
    occurredAt: NOW,
    actor: "system",
    type,
    payload,
  } as OrchestrationEvent;
};

/** The same event as the runtime ingestion writes it: from the connector. */
const fromConnector = (planned: OrchestrationEvent): OrchestrationEvent => ({
  ...planned,
  actor: "connector",
});

const created = () =>
  event("thread.created", {
    threadId,
    projectId,
    title: "Thread",
    settings: {
      model: "fake/model",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  });

const turnRequested = (turnId = makeTurnId()) =>
  event("thread.turn.requested", { turnId, text: "hello", attachments: [], mentions: [] });

const checkpoint: CheckpointSummary = {
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref: "refs/openade/checkpoints/thread/turn",
  createdAt: NOW,
};

describe("the thread fold", () => {
  it("clears the in-flight turn when the session is lost", () => {
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.session.lost", { reason: "connector binary is missing" }),
    ]);

    // The turn can never complete — the process that would complete it is
    // gone — so leaving `currentTurn` set would wedge the thread forever.
    expect(doc?.currentTurn).toBeNull();
    expect(doc?.session).toBeNull();
    expect(doc?.status).toBe("error");
  });

  it("keeps a queued message across a lost session", () => {
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.message.queued", {
        message: {
          queuedMessageId: makeItemId(),
          text: "queued",
          attachments: [],
          mentions: [],
          queuedAt: NOW,
        },
      }),
      event("thread.session.lost", { reason: "resume budget ran out" }),
    ]);

    expect(doc?.queue).toHaveLength(1);
  });

  it("drops the questions a lost session left open", () => {
    const requestId = makeRequestId();
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run npm run build",
        },
      }),
      event("thread.session.lost", { reason: "connector binary is missing" }),
    ]);

    // The process that asked is gone, so the answer has nowhere to go. Leaving
    // the card up would keep the thread reading "waiting for you" with nothing
    // the user can do about it — the same wedge `currentTurn` is cleared for.
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
  });

  it("goes back to idle once an answered plan is the last card up", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.plan.responded", { turnId, action: "revise" }),
    ]);

    // Nothing is open and no turn is running, so the thread is idle. Reading
    // the pre-event document here left it parked on "waiting" over the plan it
    // had just answered, until the next turn moved it.
    expect(doc?.pendingPlan).toBeNull();
    expect(doc?.status).toBe("idle");
  });

  it("keeps the in-flight turn while an interrupt settles", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.turn.interrupted", { turnId }),
    ]);

    // The connector has not stopped yet: the turn-scoped handle answers
    // "busy" to anything sent before it emits this turn's `turn.completed`.
    expect(doc?.currentTurn?.turnId).toBe(turnId);
    expect(doc?.interrupting).toBe(true);
    expect(doc?.status).toBe("running");
  });

  it("settles the interrupt on the connector's turn.completed", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.turn.interrupted", { turnId }),
      event("thread.turn.completed", { turnId, stopReason: "interrupted" }),
    ]);

    expect(doc?.currentTurn).toBeNull();
    expect(doc?.interrupting).toBe(false);
    expect(doc?.status).toBe("idle");
  });

  it("puts an archived idle thread back to idle on unarchive", () => {
    const doc = foldThread([
      created(),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    expect(doc?.status).toBe("idle");
    expect(doc?.currentTurn).toBeNull();
  });

  it("drops the cards an archive left open when the thread is unarchived", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.approval.opened", {
        request: {
          requestId: makeRequestId(),
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build" },
          description: "Run npm run build",
        },
      }),
      event("thread.userInput.requested", {
        requestId: makeRequestId(),
        questions: [{ questionId: "q1", question: "Which one?", options: [] }],
      }),
      event("thread.archived", {}),
      event("thread.turn.completed", { turnId, stopReason: "interrupted" }),
      event("thread.unarchived", {}),
    ]);

    // Archiving closed the session, so whoever asked is gone: leaving the
    // cards up would park the thread on "waiting" with nothing to answer.
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
    expect(doc?.status).toBe("idle");
  });

  it("keeps the session across an unarchive so the next turn resumes it", () => {
    const doc = foldThread([
      created(),
      event("thread.session.bound", {
        connectorInstanceId: makeConnectorInstanceId(),
        connectorKind: "fake",
        sessionRef: { id: "session-1" },
      }),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    expect(doc?.session?.sessionRef).toEqual({ id: "session-1" });
  });

  it("ignores the late settlement of a turn an archive closed once a newer turn runs", () => {
    const first = makeTurnId();
    const second = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(first),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
      turnRequested(second),
      // The close the archive asked for settles the first turn only now.
      event("thread.turn.completed", { turnId: first, stopReason: "interrupted" }),
    ]);

    // Ending the second turn here would let the next send start a turn the
    // connector answers "busy" to, instead of queueing it.
    expect(doc?.currentTurn?.turnId).toBe(second);
    expect(doc?.status).toBe("running");

    const settled = foldThread([
      created(),
      turnRequested(first),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
      turnRequested(second),
      event("thread.turn.completed", { turnId: first, stopReason: "interrupted" }),
      event("thread.turn.completed", { turnId: second, stopReason: "end_turn" }),
    ]);
    expect(settled?.currentTurn).toBeNull();
    expect(settled?.status).toBe("idle");
  });

  it("keeps a pending plan across an unarchive and waits on it", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.archived", {}),
      event("thread.unarchived", {}),
    ]);

    // Answering the plan starts a new turn, so it still has somewhere to go.
    expect(doc?.pendingPlan).not.toBeNull();
    expect(doc?.status).toBe("waiting");
  });

  it("marks a thread as restoring between the work order and its outcome", () => {
    const requested = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
    ]);
    expect(requested?.restoring).toBe(true);
    // Which checkpoint, not only that one is running: `threadSnapshotOf` puts
    // it on the wire so a client that reloads mid-restore keeps the spinner up
    // and the Restore button disabled.
    expect(requested?.restoringCheckpoint).toEqual(checkpoint);
    expect(threadSnapshotOf(requested!).restoring).toEqual(checkpoint);

    const done = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
      event("thread.checkpoint.restored", { checkpoint }),
    ]);
    expect(done?.restoring).toBe(false);
    expect(done?.restoringCheckpoint).toBeNull();
    expect(threadSnapshotOf(done!).restoring).toBeNull();

    const failed = foldThread([
      created(),
      event("thread.checkpoint.created", { checkpoint }),
      event("thread.checkpoint.restore.requested", { checkpoint }),
      event("thread.checkpoint.restore.failed", {
        checkpointId: checkpoint.checkpointId,
        message: "the worktree is locked",
      }),
    ]);
    expect(failed?.restoring).toBe(false);
    expect(failed?.restoringCheckpoint).toBeNull();
    expect(threadSnapshotOf(failed!).restoring).toBeNull();
  });

  it("stamps each stored item with the turn that produced it", () => {
    const turnId = makeTurnId();
    const itemId = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.item.upserted", {
        item: { itemId, kind: "assistant_message", status: "in_progress" },
        turnId,
      }),
      event("thread.item.upserted", {
        item: { itemId, kind: "assistant_message", status: "completed", text: "hi" },
        turnId,
      }),
    ]);

    // One row, still carrying its turn — a snapshot with no turn boundaries
    // cannot be grouped into settled turns by a client that joins late.
    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]?.turnId).toBe(turnId);
  });

  it("keeps a stored item's turn when a later upsert carries none", () => {
    const turnId = makeTurnId();
    const itemId = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.item.upserted", {
        item: { itemId, kind: "tool_call", status: "in_progress" },
        turnId,
      }),
      // A tool row finalised after the turn's scope closed: ingestion has no
      // turn to stamp, and the row must not lose the one it already had.
      event("thread.item.upserted", {
        item: { itemId, kind: "tool_call", status: "completed" },
      }),
    ]);

    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]?.status).toBe("completed");
    expect(doc?.items[0]?.turnId).toBe(turnId);
  });

  it("records the connector instance a settings patch chose, and keeps it after", () => {
    const chosen = makeConnectorInstanceId();
    const doc = foldThread([
      created(),
      event("thread.settings.updated", { connectorInstanceId: chosen }),
      // A later patch that says nothing about the connector leaves it alone.
      event("thread.settings.updated", { effort: "high" }),
    ]);

    expect(doc?.settings.connectorInstanceId).toBe(chosen);
    expect(doc?.settings.effort).toBe("high");
  });

  it("leaves a thread that never chose an instance without one", () => {
    const doc = foldThread([created(), event("thread.settings.updated", { effort: "low" })]);

    expect(doc?.settings).not.toHaveProperty("connectorInstanceId");
  });
});

describe("the decision record", () => {
  const upserted = (itemId = makeItemId()) =>
    event("thread.item.upserted", {
      item: { itemId, kind: "assistant_message", status: "completed", text: "hi" },
    });

  it("records an answered approval with its target and the pattern kept", () => {
    const requestId = makeRequestId();
    const lastItem = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(),
      upserted(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm run build\n--verbose" },
          description: "Run npm run build",
        },
      }),
      upserted(lastItem),
      event("thread.approval.resolved", {
        requestId,
        decision: "allow-always",
        pattern: "Shell(npm run *)",
      }),
    ]);

    expect(doc?.approvals).toEqual([]);
    expect(doc?.decisions).toEqual([
      {
        kind: "approval",
        id: requestId,
        outcome: "allow-always",
        subject: "npm run build",
        pattern: "Shell(npm run *)",
        resolvedAt: NOW,
        afterItemId: lastItem,
      },
    ]);
    expect(threadSnapshotOf(doc!).decisions).toEqual(doc?.decisions);
  });

  it("records an answered question by its first header", () => {
    const requestId = makeRequestId();
    const lastItem = makeItemId();
    const doc = foldThread([
      created(),
      turnRequested(),
      upserted(lastItem),
      event("thread.userInput.requested", {
        requestId,
        questions: [
          { questionId: "db", question: "Which database?", header: "Database", options: [] },
          { questionId: "port", question: "Which port?", options: [] },
        ],
      }),
      event("thread.userInput.resolved", {
        requestId,
        answers: [{ questionId: "db", optionIds: [], text: "sqlite" }],
      }),
    ]);

    expect(doc?.decisions).toEqual([
      {
        kind: "question",
        id: requestId,
        outcome: "answered",
        subject: "Database",
        resolvedAt: NOW,
        afterItemId: lastItem,
      },
    ]);
  });

  it("records an answered plan by its file name", () => {
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", {
        turnId,
        planMarkdown: "# plan",
        planPath: "/work/plans/health-check.md",
      }),
      event("thread.turn.completed", { turnId, stopReason: "end_turn" }),
      event("thread.plan.responded", { turnId, action: "accept-auto" }),
    ]);

    // No item landed before the answer, so the record has nothing to follow.
    expect(doc?.decisions).toEqual([
      {
        kind: "plan",
        id: turnId,
        outcome: "accept-auto",
        subject: "health-check.md",
        resolvedAt: NOW,
      },
    ]);
  });

  it("keeps one line per answer when the connector echoes it", () => {
    const requestId = makeRequestId();
    const questionId = makeRequestId();
    const doc = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
      event("thread.approval.resolved", { requestId, decision: "deny" }),
      // The connector's own `request.resolved`, arriving after the decider's.
      fromConnector(event("thread.approval.resolved", { requestId, decision: "deny" })),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", question: "Which port?", options: [] }],
      }),
      event("thread.userInput.resolved", {
        requestId: questionId,
        answers: [{ questionId: "q", optionIds: [], text: "8080" }],
      }),
      fromConnector(event("thread.userInput.resolved", { requestId: questionId, answers: [] })),
    ]);

    expect(
      doc?.decisions.map((decision) => [decision.kind, decision.id, decision.outcome]),
    ).toEqual([
      ["approval", requestId, "deny"],
      ["question", questionId, "answered"],
    ]);
  });

  it("records a card the runtime released on exit as not answered", () => {
    const requestId = makeRequestId();
    const questionId = makeRequestId();
    const turnId = makeTurnId();
    const doc = foldThread([
      created(),
      turnRequested(turnId),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "npm test" },
          description: "Run npm test",
        },
      }),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", header: "Database", question: "Which one?", options: [] }],
      }),
      // Stop kills the process; the connector releases both parked requests
      // before anyone answered them.
      event("thread.turn.interrupted", { turnId }),
      fromConnector(event("thread.approval.resolved", { requestId, decision: "deny" })),
      fromConnector(event("thread.userInput.resolved", { requestId: questionId, answers: [] })),
    ]);

    expect(
      doc?.decisions.map((decision) => [decision.kind, decision.outcome, decision.subject]),
    ).toEqual([
      ["approval", UNANSWERED_OUTCOME, "npm test"],
      ["question", UNANSWERED_OUTCOME, "Database"],
    ]);
    expect(doc?.approvals).toEqual([]);
    expect(doc?.userInputs).toEqual([]);
  });

  it("serves a document projected before decisions were kept", () => {
    const requestId = makeRequestId();
    const current = foldThread([
      created(),
      turnRequested(),
      event("thread.approval.opened", {
        request: {
          requestId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
    ])!;
    // A row an older projector wrote: the field is simply not there.
    const { decisions: _decisions, ...older } = current;
    const stored = older as unknown as ThreadDoc;

    expect(threadSnapshotOf(stored).decisions).toEqual([]);
    const next = projectThreadEvent(
      stored,
      event("thread.approval.resolved", { requestId, decision: "allow-once" }),
    );
    expect(next?.decisions.map((decision) => decision.id)).toEqual([requestId]);
  });
});

describe("what a thread is waiting on", () => {
  it("names the most urgent open card: approval, then question, then plan", () => {
    const turnId = makeTurnId();
    const approvalId = makeRequestId();
    const questionId = makeRequestId();
    const events = [
      created(),
      turnRequested(turnId),
      event("thread.plan.proposed", { turnId, planMarkdown: "# plan" }),
      event("thread.userInput.requested", {
        requestId: questionId,
        questions: [{ questionId: "q", question: "Which port?", options: [] }],
      }),
      event("thread.approval.opened", {
        request: {
          requestId: approvalId,
          kind: "command",
          toolName: "shell_command",
          input: { command: "ls" },
          description: "Run ls",
        },
      }),
    ];
    const summaryAfter = (count: number) => threadSummaryOf(foldThread(events.slice(0, count))!);

    expect(summaryAfter(2).awaitingInput).toBe(false);
    expect(summaryAfter(2)).not.toHaveProperty("awaiting");
    expect(summaryAfter(3).awaiting).toBe("plan");
    expect(summaryAfter(4).awaiting).toBe("question");
    expect(summaryAfter(5).awaiting).toBe("approval");
    expect(summaryAfter(5).awaitingInput).toBe(true);

    // Answering the approval hands the row back to the question behind it.
    const answered = foldThread([
      ...events,
      event("thread.approval.resolved", { requestId: approvalId, decision: "allow-once" }),
    ])!;
    expect(threadSummaryOf(answered).awaiting).toBe("question");
  });
});
