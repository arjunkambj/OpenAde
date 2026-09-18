/**
 * The client-side fold: applies `ThreadStreamItem`s to a `ThreadDetailSnapshot`
 * and `ThreadListStreamItem`s to a summary array. This is a projection of the
 * server's own projection — it merges deltas, it never decides anything.
 */

import type {
  CheckpointSummary,
  OrchestrationEvent,
  ThreadDetailSnapshot,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "@OpenAde/contracts/orchestration";

/** A restore git refused, kept until the next restore is ordered. */
export interface ThreadRestoreFailure {
  readonly checkpointId: string;
  readonly message: string;
}

/**
 * The snapshot plus the little the client has to track for itself.
 *
 * A checkpoint restore is a durable work order: the server accepts it
 * (`thread.checkpoint.restore.requested`), the reactor runs git, and only then
 * does `thread.checkpoint.restored` or `thread.checkpoint.restore.failed`
 * arrive. `ThreadDoc.restoring` is the server's own internal flag and is
 * deliberately not on the wire, so the client has to fold those three events
 * itself or the Changes pane cannot say that a restore is running, let alone
 * that git refused one.
 *
 * Both fields are *optional* so a plain `ThreadDetailSnapshot` — the dev
 * fixtures, a component prop typed against the contract — still satisfies this
 * type. That keeps the view from having to be plumbed through every component
 * between the atom and the pane: the object the atom emits carries the fields,
 * and only the reader that wants them has to say so.
 *
 * Known limit, because they are folded from events and not read off a
 * snapshot: they last exactly as long as the subscription that saw the
 * `restore.requested`. Reload the window, restart the server, or leave the
 * thread and come back while git is still working, and the client takes a
 * fresh snapshot and forgets — the spinner drops and Restore goes live again,
 * where the server rejects it with "is already restoring a checkpoint". The
 * fix is a `restoring` field on `ThreadDetailSnapshot`, filled from the
 * server's own `ThreadDoc.restoring`; that is an additive contracts change and
 * is not part of this wave.
 */
export interface ThreadDetailView extends ThreadDetailSnapshot {
  /** The checkpoint whose restore is running right now, if any. */
  readonly restoring?: CheckpointSummary | null;
  /** Why the last restore failed, until another one is ordered. */
  readonly restoreFailure?: ThreadRestoreFailure | null;
}

/**
 * Merges one orchestration event into the snapshot. Payload fields map
 * straight onto the document — the server's fold already validated them.
 */
export const applyThreadEvent = (
  doc: ThreadDetailView,
  event: OrchestrationEvent,
): ThreadDetailView => {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "thread.renamed":
      return { ...doc, title: payload.title as string, updatedAt: event.occurredAt };
    case "thread.archived":
      return { ...doc, status: "archived", updatedAt: event.occurredAt };
    case "thread.deleted":
      // Not the same as archived: the thread is gone from the server, so an
      // open timeline has to say so (and the route can redirect) instead of
      // sitting there looking merely filed away.
      return { ...doc, status: "deleted", currentTurnId: null, updatedAt: event.occurredAt };
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
      // The server's fold settles the thread here — no session, no turn, and
      // none of the open questions the dead process asked, because answering
      // one can never reach anybody. This has to do the same or a connected
      // client keeps an unanswerable approval card up until it resnapshots,
      // which is the very wedge the server-side fold was changed to clear.
      // The queue deliberately survives on both sides.
      return {
        ...doc,
        session: null,
        currentTurnId: null,
        pendingApproval: null,
        pendingUserInput: null,
        status: "error",
        updatedAt: event.occurredAt,
      };
    case "thread.turn.requested":
      return { ...doc, status: "running", updatedAt: event.occurredAt };
    case "thread.turn.started":
      return {
        ...doc,
        status: "running",
        currentTurnId: payload.turnId as ThreadDetailSnapshot["currentTurnId"],
        updatedAt: event.occurredAt,
      };
    case "thread.turn.interrupted":
      // An interrupt is a request, not the end of the turn: the connector
      // still has to stop and settles the turn with its own `turn.completed`.
      // The server's fold keeps `currentTurnId` here for the same reason, and
      // the two folds have to agree or a resnapshot contradicts the live view.
      return { ...doc, updatedAt: event.occurredAt };
    case "thread.turn.completed":
      // `pendingPlan` survives the turn's end: the server proposes plans late
      // in the turn and the user answers after it finishes — the plan card
      // must stay up until `thread.plan.responded` clears it.
      return {
        ...doc,
        status: doc.queue.length > 0 ? "running" : "idle",
        currentTurnId: null,
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
    case "thread.queue.reordered": {
      // The same fold the server projection does: the event carries the whole
      // order, so an id the queue no longer holds simply does not place one.
      const order = payload.order as ReadonlyArray<string>;
      const rank = new Map(order.map((id, index) => [id, index]));
      return {
        ...doc,
        queue: [...doc.queue].sort(
          (a, b) =>
            (rank.get(a.queuedMessageId) ?? order.length) -
            (rank.get(b.queuedMessageId) ?? order.length),
        ),
        updatedAt: event.occurredAt,
      };
    }
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
    case "thread.checkpoint.restore.requested":
      // The order is accepted and durable; the git work has not run yet. A
      // previous failure is cleared here rather than when the new one lands,
      // so the pane stops showing a stale error the moment the user retries.
      return {
        ...doc,
        restoring: payload.checkpoint as CheckpointSummary,
        restoreFailure: null,
        updatedAt: event.occurredAt,
      };
    case "thread.checkpoint.restored":
      return { ...doc, restoring: null, restoreFailure: null, updatedAt: event.occurredAt };
    case "thread.checkpoint.restore.failed":
      // git refused — a dirty worktree, a missing ref, a dirty submodule. The
      // message is the only thing that says which, so it outlives the event.
      return {
        ...doc,
        restoring: null,
        restoreFailure: {
          checkpointId: payload.checkpointId as string,
          message: payload.message as string,
        },
        updatedAt: event.occurredAt,
      };
    case "thread.error":
      // `error`, not `idle`: apps/server/src/orchestration/state.ts settles a
      // fatal error that way, and a fatal error outside a turn has no
      // `turn.completed` behind it to converge the two folds. Saying `idle`
      // here left the header pill disagreeing with the sidebar row — which is
      // fed by the server's own `ThreadSummary` — until a resnapshot flipped
      // it with nothing having happened in between.
      return payload.fatal === true
        ? { ...doc, status: "error", currentTurnId: null, updatedAt: event.occurredAt }
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
  doc: ThreadDetailView | null,
  item: ThreadStreamItem,
): ThreadDetailView | null => {
  switch (item.kind) {
    case "snapshot":
      // A snapshot replaces the doc wholesale, restore flags included. Every
      // path that produces one has already thrown the old doc away: the atom
      // clears it on `resnapshot-required`, and the subscribe loop clears it
      // whenever it asks without `afterSequence` — which is the only ask the
      // server answers with a snapshot at all. See the type's docblock for
      // what that costs.
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
    case "resnapshot-required":
      // The server can no longer replay from where this client stands, so
      // everything held is suspect — drop it and wait for the fresh snapshot
      // rather than showing a list that quietly stopped updating.
      return [];
    default:
      return threads;
  }
};
