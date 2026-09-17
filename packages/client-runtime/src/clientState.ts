/**
 * The client-side fold: applies `ThreadStreamItem`s to a `ThreadDetailSnapshot`
 * and `ThreadListStreamItem`s to a summary array. This is a projection of the
 * server's own projection — it merges deltas, it never decides anything.
 */

import type {
  OrchestrationEvent,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";

/**
 * Merges one orchestration event into the snapshot. Payload fields map
 * straight onto the document — the server's fold already validated them.
 */
export const applyThreadEvent = (
  doc: ThreadDetailSnapshot,
  event: OrchestrationEvent,
): ThreadDetailSnapshot => {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "thread.renamed":
      return { ...doc, title: payload.title as string, updatedAt: event.occurredAt };
    case "thread.archived":
      return { ...doc, status: "archived", updatedAt: event.occurredAt };
    case "thread.deleted":
      return { ...doc, status: "archived", updatedAt: event.occurredAt };
    case "thread.session.bound":
      return {
        ...doc,
        session: {
          connectorInstanceId: payload.connectorInstanceId,
          connectorKind: payload.connectorKind,
          sessionRef: payload.sessionRef,
        } as ThreadDetailSnapshot["session"],
        updatedAt: event.occurredAt,
      };
    case "thread.session.lost":
      return { ...doc, session: null, status: "idle", updatedAt: event.occurredAt };
    case "thread.turn.requested":
      return { ...doc, status: "running", updatedAt: event.occurredAt };
    case "thread.turn.started":
      return {
        ...doc,
        status: "running",
        currentTurnId: payload.turnId as ThreadDetailSnapshot["currentTurnId"],
        updatedAt: event.occurredAt,
      };
    case "thread.turn.completed":
    case "thread.turn.interrupted":
      return {
        ...doc,
        status: doc.queue.length > 0 ? "running" : "idle",
        currentTurnId: null,
        pendingPlan: null,
        updatedAt: event.occurredAt,
      };
    case "thread.message.queued":
      return {
        ...doc,
        queue: [...doc.queue, payload.message as never],
        updatedAt: event.occurredAt,
      };
    case "thread.message.dequeued":
      return {
        ...doc,
        queue: doc.queue.filter((message) => message.queuedMessageId !== payload.queuedMessageId),
        updatedAt: event.occurredAt,
      };
    case "thread.item.upserted": {
      const item = payload.item as ThreadDetailSnapshot["items"][number];
      const index = doc.items.findIndex((existing) => existing.itemId === item.itemId);
      return {
        ...doc,
        items:
          index === -1
            ? [...doc.items, item]
            : doc.items.map((existing, i) => (i === index ? item : existing)),
        updatedAt: event.occurredAt,
      };
    }
    case "thread.approval.opened":
      return {
        ...doc,
        pendingApproval: payload.request as ThreadDetailSnapshot["pendingApproval"],
        updatedAt: event.occurredAt,
      };
    case "thread.approval.resolved":
      return doc.pendingApproval?.requestId === payload.requestId
        ? { ...doc, pendingApproval: null, updatedAt: event.occurredAt }
        : doc;
    case "thread.userInput.requested":
      return {
        ...doc,
        pendingUserInput: {
          requestId: payload.requestId,
          questions: payload.questions,
        } as ThreadDetailSnapshot["pendingUserInput"],
        updatedAt: event.occurredAt,
      };
    case "thread.userInput.resolved":
      return doc.pendingUserInput?.requestId === payload.requestId
        ? { ...doc, pendingUserInput: null, updatedAt: event.occurredAt }
        : doc;
    case "thread.plan.proposed":
      return {
        ...doc,
        pendingPlan: {
          turnId: payload.turnId,
          planMarkdown: payload.planMarkdown,
          planPath: payload.planPath,
        } as ThreadDetailSnapshot["pendingPlan"],
        updatedAt: event.occurredAt,
      };
    case "thread.plan.responded":
      return doc.pendingPlan?.turnId === payload.turnId
        ? { ...doc, pendingPlan: null, updatedAt: event.occurredAt }
        : doc;
    case "thread.settings.updated":
      return {
        ...doc,
        settings: { ...doc.settings, ...payload } as ThreadDetailSnapshot["settings"],
        updatedAt: event.occurredAt,
      };
    case "thread.usage.updated":
      return { ...doc, usage: payload.usage as never, updatedAt: event.occurredAt };
    case "thread.context.updated":
      return { ...doc, context: payload as never, updatedAt: event.occurredAt };
    case "thread.checkpoint.created":
      return {
        ...doc,
        checkpoints: [
          ...doc.checkpoints,
          payload.checkpoint as ThreadDetailSnapshot["checkpoints"][number],
        ],
        updatedAt: event.occurredAt,
      };
    case "thread.error":
      return payload.fatal === true
        ? { ...doc, status: "idle", currentTurnId: null, updatedAt: event.occurredAt }
        : doc;
    default:
      return doc;
  }
};

/**
 * The live thread view. `synchronized` isn't an update — the atom uses it to
 * flip its own "caught up" flag.
 */
export const applyThreadStreamItem = (
  doc: ThreadDetailSnapshot | null,
  item: ThreadStreamItem,
): ThreadDetailSnapshot | null => {
  switch (item.kind) {
    case "snapshot":
      return item.snapshot;
    case "event":
      return doc === null || item.event.sequence <= doc.snapshotSequence
        ? doc
        : { ...applyThreadEvent(doc, item.event), snapshotSequence: item.event.sequence };
    default:
      return doc;
  }
};

/** The sidebar list fold — keyed by threadId, `snapshot` replaces wholesale. */
export const applyThreadListItem = (
  threads: ReadonlyArray<ThreadSummary>,
  item: ThreadListStreamItem,
): ReadonlyArray<ThreadSummary> => {
  switch (item.kind) {
    case "snapshot":
      return item.threads;
    case "upserted": {
      const index = threads.findIndex((t) => t.threadId === item.thread.threadId);
      return index === -1
        ? [...threads, item.thread]
        : threads.map((t, i) => (i === index ? item.thread : t));
    }
    case "removed":
      return threads.filter((t) => t.threadId !== item.threadId);
    default:
      return threads;
  }
};
