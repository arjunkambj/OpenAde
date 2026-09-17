/**
 * The thread fold, driven straight from event sequences.
 *
 * Every case here is a state the decider later reads back — a fold that gets
 * one of them wrong wedges a thread rather than merely showing it wrong.
 */

import { describe, expect, it } from "vitest";

import {
  makeEventId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@OpenAde/contracts/ids";
import type { OrchestrationEvent } from "@OpenAde/contracts/orchestration";

import { foldThread } from "./state";

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
});
