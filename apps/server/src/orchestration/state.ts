/**
 * The per-aggregate fold: events in, read-model state out.
 *
 * `ThreadDoc` is the stored form of a thread — the wire `ThreadDetailSnapshot`
 * plus the bookkeeping the decider needs (`approvals` is the full open set, of
 * which the wire sees only the first). The same fold drives the decider's view
 * of a stream and the projection written back to `threads.doc_json`, so the
 * decision and the stored read model can never disagree.
 */

import type {
  Attachment,
  CheckpointSummary,
  Mention,
  OrchestrationEvent,
  ProjectSummary,
  QueuedMessage,
  ThreadDetailSnapshot,
  ThreadSession,
  ThreadSettings,
  ThreadStatus,
  ThreadSummary,
  TurnUsage,
  ContextWindowUsage,
} from "@OpenAde/contracts/orchestration";
import type { ProjectId, RequestId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest, ItemSnapshot, UserQuestion } from "@OpenAde/contracts/runtime";

export type { ApprovalRequest, ItemSnapshot, QueuedMessage, UserQuestion };

// ── Documents ─────────────────────────────────────────────────

export interface PendingUserInput {
  readonly requestId: RequestId;
  readonly questions: ReadonlyArray<UserQuestion>;
}

export interface PendingPlan {
  readonly turnId: TurnId;
  readonly planMarkdown: string;
  readonly planPath?: string;
}

/**
 * The stored thread document: every `ThreadDetailSnapshot` field, plus the
 * internal fields (`approvals`, `userInputs`, `preview`, `deleted`) that the
 * wire never sees.
 */
export interface ThreadDoc {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly settings: ThreadSettings;
  readonly snapshotSequence: number;
  readonly items: ReadonlyArray<ItemSnapshot>;
  readonly queue: ReadonlyArray<QueuedMessage>;
  readonly checkpoints: ReadonlyArray<CheckpointSummary>;
  readonly session: ThreadSession | null;
  /**
   * The in-flight turn, with the input it was sent with — resuming a session
   * mid-turn re-sends this, so the input has to live in the document.
   */
  readonly currentTurn: {
    readonly turnId: TurnId;
    readonly input: {
      readonly text: string;
      readonly attachments: ReadonlyArray<Attachment>;
      readonly mentions: ReadonlyArray<Mention>;
    };
  } | null;
  readonly pendingPlan: PendingPlan | null;
  readonly usage: TurnUsage | null;
  readonly context: ContextWindowUsage | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  // Internal bookkeeping, not on the wire.
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  readonly userInputs: ReadonlyArray<PendingUserInput>;
  readonly preview: string | undefined;
  readonly deleted: boolean;
}

export interface ProjectDoc {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removed: boolean;
}

const PREVIEW_LENGTH = 140;

const previewOf = (item: ItemSnapshot): string | undefined =>
  (item.kind === "user_message" || item.kind === "assistant_message") && item.text !== undefined
    ? item.text.slice(0, PREVIEW_LENGTH)
    : undefined;

const waitingOr = (doc: ThreadDoc, fallback: ThreadStatus): ThreadStatus =>
  doc.approvals.length > 0 || doc.userInputs.length > 0 || doc.pendingPlan !== null
    ? "waiting"
    : fallback;

// ── Thread fold ───────────────────────────────────────────────

const applyThreadEvent = (doc: ThreadDoc | null, event: OrchestrationEvent): ThreadDoc | null => {
  if (event.streamKind !== "thread") {
    return doc;
  }
  const type = event.type;
  const payload = event.payload as Record<string, unknown>;

  if (type === "thread.created") {
    return {
      threadId: payload.threadId as ThreadId,
      projectId: payload.projectId as ProjectId,
      title: payload.title as string,
      status: "idle",
      settings: payload.settings as ThreadSettings,
      snapshotSequence: event.sequence,
      items: [],
      queue: [],
      checkpoints: [],
      session: null,
      currentTurn: null,
      pendingPlan: null,
      usage: null,
      context: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      approvals: [],
      userInputs: [],
      preview: undefined,
      deleted: false,
    };
  }

  if (doc === null) {
    return null;
  }
  const next = { ...doc, snapshotSequence: event.sequence, updatedAt: event.occurredAt };

  switch (type) {
    case "thread.renamed":
      return { ...next, title: payload.title as string };
    case "thread.archived":
      return { ...next, status: "archived" };
    case "thread.deleted":
      return { ...next, deleted: true };
    case "thread.session.bound":
      return {
        ...next,
        session: {
          connectorInstanceId: payload.connectorInstanceId as ThreadSession["connectorInstanceId"],
          connectorKind: payload.connectorKind as string,
          sessionRef: payload.sessionRef,
        },
      };
    case "thread.session.lost":
      return { ...next, session: null, status: "error" };
    case "thread.turn.requested":
      return {
        ...next,
        currentTurn: {
          turnId: payload.turnId as TurnId,
          input: {
            text: payload.text as string,
            attachments: (payload.attachments ?? []) as ReadonlyArray<Attachment>,
            mentions: (payload.mentions ?? []) as ReadonlyArray<Mention>,
          },
        },
        status: "running",
      };
    case "thread.turn.started":
      return { ...next, status: "running" };
    case "thread.turn.completed":
    case "thread.turn.interrupted":
      return {
        ...next,
        currentTurn: null,
        status: waitingOr(doc, "idle"),
      };
    case "thread.message.queued":
      return {
        ...next,
        queue: [...doc.queue, payload.message as QueuedMessage],
      };
    case "thread.message.dequeued":
      return {
        ...next,
        queue: doc.queue.filter(
          (message) => message.queuedMessageId !== (payload.queuedMessageId as string),
        ),
      };
    case "thread.item.upserted": {
      const item = payload.item as ItemSnapshot;
      const index = doc.items.findIndex((existing) => existing.itemId === item.itemId);
      const items =
        index === -1
          ? [...doc.items, item]
          : doc.items.map((existing, i) => (i === index ? item : existing));
      const preview = previewOf(item) ?? doc.preview;
      return { ...next, items, preview };
    }
    case "thread.approval.opened":
      return {
        ...next,
        approvals: [...doc.approvals, payload.request as ApprovalRequest],
        status: "waiting",
      };
    case "thread.approval.resolved": {
      const approvals = doc.approvals.filter(
        (request) => request.requestId !== (payload.requestId as string),
      );
      return {
        ...next,
        approvals,
        status: doc.currentTurn === null ? waitingOr({ ...doc, approvals }, "idle") : "running",
      };
    }
    case "thread.userInput.requested":
      return {
        ...next,
        userInputs: [
          ...doc.userInputs,
          {
            requestId: payload.requestId as RequestId,
            questions: payload.questions as ReadonlyArray<UserQuestion>,
          },
        ],
        status: "waiting",
      };
    case "thread.userInput.resolved": {
      const userInputs = doc.userInputs.filter(
        (pending) => pending.requestId !== (payload.requestId as string),
      );
      return {
        ...next,
        userInputs,
        status: doc.currentTurn === null ? waitingOr({ ...doc, userInputs }, "idle") : "running",
      };
    }
    case "thread.plan.proposed":
      return {
        ...next,
        pendingPlan: {
          turnId: payload.turnId as TurnId,
          planMarkdown: payload.planMarkdown as string,
          ...(payload.planPath === undefined ? {} : { planPath: payload.planPath as string }),
        },
        status: "waiting",
      };
    case "thread.plan.responded":
      return {
        ...next,
        pendingPlan: null,
        status: doc.currentTurn === null ? waitingOr(doc, "idle") : "running",
      };
    case "thread.settings.updated":
      return {
        ...next,
        settings: {
          model: (payload.model as string | undefined) ?? doc.settings.model,
          effort:
            payload.effort === undefined
              ? doc.settings.effort
              : (payload.effort as ThreadSettings["effort"]),
          runtimeMode:
            (payload.runtimeMode as ThreadSettings["runtimeMode"]) ?? doc.settings.runtimeMode,
          interactionMode:
            (payload.interactionMode as ThreadSettings["interactionMode"]) ??
            doc.settings.interactionMode,
        },
      };
    case "thread.usage.updated":
      return { ...next, usage: payload.usage as TurnUsage };
    case "thread.context.updated":
      return { ...next, context: payload as unknown as ContextWindowUsage };
    case "thread.checkpoint.created":
      return {
        ...next,
        checkpoints: [...doc.checkpoints, payload.checkpoint as CheckpointSummary],
      };
    case "thread.checkpoint.restored":
      // The worktree moved back; the document has nothing to rewind — the
      // checkpoint refs still exist and the event still bumps the sequence.
      return next;
    case "thread.error":
      return payload.fatal === true ? { ...next, status: "error", currentTurn: null } : next;
    default:
      return next;
  }
};

/** Folds one thread stream into its document. */
export const foldThread = (events: ReadonlyArray<OrchestrationEvent>): ThreadDoc | null => {
  let doc: ThreadDoc | null = null;
  for (const event of events) {
    doc = applyThreadEvent(doc, event);
  }
  return doc;
};

/** Applies one event to an already-folded document — the projector's step. */
export const projectThreadEvent = applyThreadEvent;

// ── Project fold ──────────────────────────────────────────────

const applyProjectEvent = (
  doc: ProjectDoc | null,
  event: OrchestrationEvent,
): ProjectDoc | null => {
  if (event.streamKind !== "project") {
    return doc;
  }
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "project.created") {
    return {
      projectId: payload.projectId as ProjectId,
      name: payload.name as string,
      workspaceRoot: payload.workspaceRoot as string,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      removed: false,
    };
  }
  if (doc === null) {
    return null;
  }
  if (event.type === "project.removed") {
    return { ...doc, removed: true, updatedAt: event.occurredAt };
  }
  return doc;
};

export const foldProject = (events: ReadonlyArray<OrchestrationEvent>): ProjectDoc | null => {
  let doc: ProjectDoc | null = null;
  for (const event of events) {
    doc = applyProjectEvent(doc, event);
  }
  return doc;
};

/** The projector's step for the project stream. */
export const projectProjectEvent = applyProjectEvent;

// ── Wire shapes ───────────────────────────────────────────────

/** The `ThreadDetailSnapshot` a subscription's `snapshot` item carries. */
export const threadSnapshotOf = (doc: ThreadDoc): ThreadDetailSnapshot => ({
  threadId: doc.threadId,
  projectId: doc.projectId,
  title: doc.title,
  status: doc.status,
  settings: doc.settings,
  snapshotSequence: doc.snapshotSequence,
  items: doc.items,
  queue: doc.queue,
  checkpoints: doc.checkpoints,
  session: doc.session,
  currentTurnId: doc.currentTurn?.turnId ?? null,
  pendingApproval: doc.approvals[0] ?? null,
  pendingUserInput: doc.userInputs[0] ?? null,
  pendingPlan: doc.pendingPlan,
  usage: doc.usage,
  context: doc.context,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** The `ThreadSummary` the sidebar lists. */
export const threadSummaryOf = (doc: ThreadDoc): ThreadSummary => ({
  threadId: doc.threadId,
  projectId: doc.projectId,
  title: doc.title,
  status: doc.status,
  settings: doc.settings,
  ...(doc.preview === undefined ? {} : { preview: doc.preview }),
  awaitingInput: doc.approvals.length > 0 || doc.userInputs.length > 0 || doc.pendingPlan !== null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const projectSummaryOf = (doc: ProjectDoc, threadCount: number): ProjectSummary => ({
  projectId: doc.projectId,
  name: doc.name,
  workspaceRoot: doc.workspaceRoot,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  threadCount,
});
