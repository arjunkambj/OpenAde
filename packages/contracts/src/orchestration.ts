/**
 * The client → server command set and the event log it produces.
 *
 * The server is an event-sourced decider: a client never mutates state, it
 * dispatches a `Command` and gets a `CommandReceipt` back. The decider turns
 * the command into zero or more `OrchestrationEvent`s, which are appended,
 * projected and published. Every id a command needs is minted by the caller, so
 * dispatching twice with the same `commandId` is a no-op rather than a second
 * thread — that is what makes reconnects and retries safe.
 *
 * `ThreadStreamItem` is what a subscriber actually sees: one snapshot, then
 * events, with `synchronized` marking the point where live delivery begins and
 * `resnapshot-required` telling the client its position is no longer replayable.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { ApprovalDecision, Effort, InteractionMode, RuntimeMode } from "./enums";
import {
  CheckpointId,
  CommandId,
  ConnectorInstanceId,
  ConnectorKind,
  EventId,
  ItemId,
  ProjectId,
  RequestId,
  ThreadId,
  TurnId,
  UuidV7,
} from "./ids";
import {
  ApprovalRequest,
  ItemSnapshot,
  TurnStopReason,
  UserQuestion,
  UserQuestionAnswer,
} from "./runtime";

// ── Shared value objects ───────────────────────────────────────

/**
 * A file the user attached to a turn, already written to the attachments dir.
 * `mime` is the spec's field name (section 7) and is optional because a plain
 * path drop carries no declared type.
 */
export const Attachment = Schema.Struct({
  path: NonEmptyString,
  mime: Schema.optional(NonEmptyString),
});
export type Attachment = typeof Attachment.Type;

/** An `@`-mention from the composer: a workspace-relative path. */
export const Mention = NonEmptyString;
export type Mention = typeof Mention.Type;

/** The per-thread controls the header exposes. */
export const ThreadSettings = Schema.Struct({
  model: NonEmptyString,
  effort: Schema.optional(Effort),
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
});
export type ThreadSettings = typeof ThreadSettings.Type;

/** A partial update of `ThreadSettings`; absent fields are left alone. */
export const ThreadSettingsPatch = Schema.Struct({
  model: Schema.optional(NonEmptyString),
  effort: Schema.optional(Effort),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(InteractionMode),
});
export type ThreadSettingsPatch = typeof ThreadSettingsPatch.Type;

/** What the user typed while a turn was still running. */
export const QueuedMessage = Schema.Struct({
  queuedMessageId: ItemId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  queuedAt: IsoDateTime,
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** Token accounting for one turn. */
export const TurnUsage = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  costUsd: Schema.optional(Schema.Number),
});
export type TurnUsage = typeof TurnUsage.Type;

/** How much of the model's context window the thread is using. */
export const ContextWindowUsage = Schema.Struct({
  used: NonNegativeInt,
  limit: NonNegativeInt,
});
export type ContextWindowUsage = typeof ContextWindowUsage.Type;

/** One per-turn worktree snapshot, stored as a hidden git ref. */
export const CheckpointSummary = Schema.Struct({
  checkpointId: CheckpointId,
  turnId: TurnId,
  ref: NonEmptyString,
  createdAt: IsoDateTime,
});
export type CheckpointSummary = typeof CheckpointSummary.Type;

/** The connector session a thread is currently bound to, if any. */
export const ThreadSession = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  connectorKind: ConnectorKind,
  sessionRef: Schema.Unknown,
});
export type ThreadSession = typeof ThreadSession.Type;

/**
 * What the sidebar pill shows. `deleted` is produced by the client fold when a
 * `thread.deleted` event arrives for a thread that is open — the server never
 * sends it, because a deleted thread leaves the read model entirely. It exists
 * so an open timeline can say the thread is gone instead of quietly claiming
 * it was archived.
 */
export const ThreadStatus = Schema.Literals([
  "idle",
  "running",
  "waiting",
  "error",
  "archived",
  "deleted",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

/** What the user chose on a proposed plan. */
export const PlanResponseAction = Schema.Literals(["accept", "accept-auto", "revise"]);
export type PlanResponseAction = typeof PlanResponseAction.Type;

// ── Commands ───────────────────────────────────────────────────

const commandBase = {
  commandId: CommandId,
  createdAt: IsoDateTime,
};

/** Builds one command variant: the shared base, a literal `type`, and its fields. */
const command = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ ...commandBase, type: Schema.Literal(type), ...fields });

const ProjectCreateCommand = command("project.create", {
  projectId: ProjectId,
  name: NonEmptyString,
  workspaceRoot: NonEmptyString,
});

const ProjectRemoveCommand = command("project.remove", { projectId: ProjectId });

const ThreadCreateCommand = command("thread.create", {
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.optional(NonEmptyString),
  settings: Schema.optional(ThreadSettingsPatch),
});

const ThreadRenameCommand = command("thread.rename", {
  threadId: ThreadId,
  title: NonEmptyString,
});

const ThreadArchiveCommand = command("thread.archive", { threadId: ThreadId });

const ThreadDeleteCommand = command("thread.delete", { threadId: ThreadId });

/**
 * Start a turn, or queue it. `queued` is the composer's Cmd+Enter: with a turn
 * already running the text goes on the queue instead of racing the session,
 * because print-mode harnesses cannot take a mid-turn message.
 */
const ThreadTurnStartCommand = command("thread.turn.start", {
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  queued: Schema.Boolean,
});

const ThreadTurnInterruptCommand = command("thread.turn.interrupt", { threadId: ThreadId });

const ThreadSettingsUpdateCommand = Schema.Struct({
  ...commandBase,
  type: Schema.Literal("thread.settings.update"),
  threadId: ThreadId,
  ...ThreadSettingsPatch.fields,
});

/**
 * Answer an approval card. `pattern` carries the rule "allow always" should
 * persist — the card lets the user edit the suggestion before accepting it, so
 * the client sends the final text rather than the server re-deriving it.
 */
const ThreadApprovalRespondCommand = command("thread.approval.respond", {
  threadId: ThreadId,
  requestId: RequestId,
  decision: ApprovalDecision,
  pattern: Schema.optional(NonEmptyString),
});

const ThreadUserInputRespondCommand = command("thread.userInput.respond", {
  threadId: ThreadId,
  requestId: RequestId,
  answers: Schema.Array(UserQuestionAnswer),
});

const ThreadPlanRespondCommand = command("thread.plan.respond", {
  threadId: ThreadId,
  turnId: TurnId,
  action: PlanResponseAction,
  feedback: Schema.optional(Schema.String),
});

/**
 * Take a queued follow-up back out of the queue. Emits
 * `thread.message.dequeued`, the same event the reactor emits when the next
 * turn consumes one, so the read model needs nothing new.
 */
const ThreadQueueRemoveCommand = command("thread.queue.remove", {
  threadId: ThreadId,
  queuedMessageId: ItemId,
});

const ThreadCheckpointRestoreCommand = command("thread.checkpoint.restore", {
  threadId: ThreadId,
  checkpointId: CheckpointId,
});

export const Command = Schema.Union([
  ProjectCreateCommand,
  ProjectRemoveCommand,
  ThreadCreateCommand,
  ThreadRenameCommand,
  ThreadArchiveCommand,
  ThreadDeleteCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadSettingsUpdateCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadPlanRespondCommand,
  ThreadQueueRemoveCommand,
  ThreadCheckpointRestoreCommand,
]);
export type Command = typeof Command.Type;

/**
 * The type tags of `Command`, as data. A test keeps this list and the union's
 * members in lockstep.
 */
export const CommandType = Schema.Literals([
  "project.create",
  "project.remove",
  "thread.create",
  "thread.rename",
  "thread.archive",
  "thread.delete",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.settings.update",
  "thread.approval.respond",
  "thread.userInput.respond",
  "thread.plan.respond",
  "thread.queue.remove",
  "thread.checkpoint.restore",
]);
export type CommandType = typeof CommandType.Type;

/** The `type` tag of each command, in declaration order. */
export const commandTypes: ReadonlyArray<CommandType> = Command.members.map(
  (member) => member.fields.type.literal,
);

/**
 * The answer to a dispatch. `lastSequence` is the event-log position the
 * command's effects are visible at, so a client can wait for its own write to
 * appear on the subscription before acting on it.
 */
export const CommandReceipt = Schema.Struct({
  commandId: CommandId,
  status: Schema.Literals(["accepted", "rejected"]),
  reason: Schema.optional(NonEmptyString),
  lastSequence: NonNegativeInt,
});
export type CommandReceipt = typeof CommandReceipt.Type;

// ── Events ─────────────────────────────────────────────────────

/** Which aggregate an event belongs to. */
export const StreamKind = Schema.Literals(["project", "thread"]);
export type StreamKind = typeof StreamKind.Type;

/** Who caused an event: a person, the server itself, or a connector's output. */
export const Actor = Schema.Literals(["user", "system", "connector"]);
export type Actor = typeof Actor.Type;

/**
 * The fields every event carries. `sequence` is the global append order the
 * subscription pages on; `streamVersion` is the per-aggregate version the
 * optimistic-concurrency check uses. `causationEventId` and `correlationId`
 * make a reactor's downstream events traceable back to the command that caused
 * them.
 */
const eventBase = {
  sequence: NonNegativeInt,
  eventId: EventId,
  streamKind: StreamKind,
  streamId: UuidV7,
  streamVersion: NonNegativeInt,
  occurredAt: IsoDateTime,
  commandId: Schema.optional(CommandId),
  causationEventId: Schema.optional(EventId),
  correlationId: Schema.optional(UuidV7),
  actor: Actor,
};

/** Builds one event variant: the shared base, a literal `type`, and its payload. */
const orchestrationEvent = <
  const Type extends string,
  Payload extends Schema.Struct<Schema.Struct.Fields>,
>(
  type: Type,
  payload: Payload,
) => Schema.Struct({ ...eventBase, type: Schema.Literal(type), payload });

const ProjectCreatedEvent = orchestrationEvent(
  "project.created",
  Schema.Struct({
    projectId: ProjectId,
    name: NonEmptyString,
    workspaceRoot: NonEmptyString,
  }),
);

const ProjectRemovedEvent = orchestrationEvent(
  "project.removed",
  Schema.Struct({ projectId: ProjectId }),
);

const ThreadCreatedEvent = orchestrationEvent(
  "thread.created",
  Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    title: NonEmptyString,
    settings: ThreadSettings,
  }),
);

const ThreadRenamedEvent = orchestrationEvent(
  "thread.renamed",
  Schema.Struct({ title: NonEmptyString }),
);

const ThreadArchivedEvent = orchestrationEvent("thread.archived", Schema.Struct({}));

const ThreadDeletedEvent = orchestrationEvent("thread.deleted", Schema.Struct({}));

const ThreadSessionBoundEvent = orchestrationEvent(
  "thread.session.bound",
  Schema.Struct({
    connectorInstanceId: ConnectorInstanceId,
    connectorKind: ConnectorKind,
    sessionRef: Schema.Unknown,
  }),
);

const ThreadSessionLostEvent = orchestrationEvent(
  "thread.session.lost",
  Schema.Struct({ reason: NonEmptyString }),
);

const ThreadTurnRequestedEvent = orchestrationEvent(
  "thread.turn.requested",
  Schema.Struct({
    turnId: TurnId,
    text: Schema.String,
    attachments: Schema.Array(Attachment),
    mentions: Schema.Array(Mention),
  }),
);

const ThreadTurnStartedEvent = orchestrationEvent(
  "thread.turn.started",
  Schema.Struct({ turnId: TurnId }),
);

const ThreadTurnCompletedEvent = orchestrationEvent(
  "thread.turn.completed",
  Schema.Struct({ turnId: TurnId, stopReason: TurnStopReason }),
);

const ThreadTurnInterruptedEvent = orchestrationEvent(
  "thread.turn.interrupted",
  Schema.Struct({ turnId: TurnId }),
);

const ThreadMessageQueuedEvent = orchestrationEvent(
  "thread.message.queued",
  Schema.Struct({ message: QueuedMessage }),
);

const ThreadMessageDequeuedEvent = orchestrationEvent(
  "thread.message.dequeued",
  Schema.Struct({ queuedMessageId: ItemId, turnId: Schema.optional(TurnId) }),
);

const ThreadItemUpsertedEvent = orchestrationEvent(
  "thread.item.upserted",
  Schema.Struct({ item: ItemSnapshot, turnId: Schema.optional(TurnId) }),
);

const ThreadApprovalOpenedEvent = orchestrationEvent(
  "thread.approval.opened",
  Schema.Struct({ request: ApprovalRequest }),
);

const ThreadApprovalResolvedEvent = orchestrationEvent(
  "thread.approval.resolved",
  Schema.Struct({
    requestId: RequestId,
    decision: ApprovalDecision,
    pattern: Schema.optional(NonEmptyString),
  }),
);

const ThreadUserInputRequestedEvent = orchestrationEvent(
  "thread.userInput.requested",
  Schema.Struct({ requestId: RequestId, questions: Schema.Array(UserQuestion) }),
);

const ThreadUserInputResolvedEvent = orchestrationEvent(
  "thread.userInput.resolved",
  Schema.Struct({ requestId: RequestId, answers: Schema.Array(UserQuestionAnswer) }),
);

const ThreadPlanProposedEvent = orchestrationEvent(
  "thread.plan.proposed",
  Schema.Struct({
    turnId: TurnId,
    planMarkdown: Schema.String,
    planPath: Schema.optional(NonEmptyString),
  }),
);

/**
 * `planPath` is the plan file the answer is about, copied from the pending
 * plan as it is answered. The accept turn names the file ("Implement the
 * approved plan at <path>"), and by the time a reactor sees this event the
 * fold has already cleared `pendingPlan` — carrying it on the event is what
 * lets that turn survive a restart between proposing a plan and accepting it.
 */
const ThreadPlanRespondedEvent = orchestrationEvent(
  "thread.plan.responded",
  Schema.Struct({
    turnId: TurnId,
    action: PlanResponseAction,
    feedback: Schema.optional(Schema.String),
    planPath: Schema.optional(NonEmptyString),
  }),
);

const ThreadSettingsUpdatedEvent = orchestrationEvent(
  "thread.settings.updated",
  ThreadSettingsPatch,
);

const ThreadUsageUpdatedEvent = orchestrationEvent(
  "thread.usage.updated",
  Schema.Struct({ turnId: TurnId, usage: TurnUsage }),
);

const ThreadContextUpdatedEvent = orchestrationEvent("thread.context.updated", ContextWindowUsage);

const ThreadCheckpointCreatedEvent = orchestrationEvent(
  "thread.checkpoint.created",
  Schema.Struct({ checkpoint: CheckpointSummary }),
);

/**
 * The durable work order: an accepted `thread.checkpoint.restore`, recorded
 * before any git runs. The CheckpointReactor acts on this event, and replays
 * any that has no `restored`/`restore.failed` successor at boot, so a crash
 * between command receipt and the git work cannot silently drop the request.
 */
const ThreadCheckpointRestoreRequestedEvent = orchestrationEvent(
  "thread.checkpoint.restore.requested",
  Schema.Struct({ checkpoint: CheckpointSummary }),
);

/** The worktree really moved — emitted only after the git work succeeded. */
const ThreadCheckpointRestoredEvent = orchestrationEvent(
  "thread.checkpoint.restored",
  Schema.Struct({ checkpoint: CheckpointSummary }),
);

/**
 * The restore did not happen: a locked directory, a garbage-collected ref, a
 * dirty submodule. Carries the checkpoint it was for, so a client can put the
 * failure on the right row instead of showing a stray error line.
 */
const ThreadCheckpointRestoreFailedEvent = orchestrationEvent(
  "thread.checkpoint.restore.failed",
  Schema.Struct({ checkpointId: CheckpointId, message: NonEmptyString }),
);

const ThreadErrorEvent = orchestrationEvent(
  "thread.error",
  Schema.Struct({ message: NonEmptyString, fatal: Schema.Boolean }),
);

export const OrchestrationEvent = Schema.Union([
  ProjectCreatedEvent,
  ProjectRemovedEvent,
  ThreadCreatedEvent,
  ThreadRenamedEvent,
  ThreadArchivedEvent,
  ThreadDeletedEvent,
  ThreadSessionBoundEvent,
  ThreadSessionLostEvent,
  ThreadTurnRequestedEvent,
  ThreadTurnStartedEvent,
  ThreadTurnCompletedEvent,
  ThreadTurnInterruptedEvent,
  ThreadMessageQueuedEvent,
  ThreadMessageDequeuedEvent,
  ThreadItemUpsertedEvent,
  ThreadApprovalOpenedEvent,
  ThreadApprovalResolvedEvent,
  ThreadUserInputRequestedEvent,
  ThreadUserInputResolvedEvent,
  ThreadPlanProposedEvent,
  ThreadPlanRespondedEvent,
  ThreadSettingsUpdatedEvent,
  ThreadUsageUpdatedEvent,
  ThreadContextUpdatedEvent,
  ThreadCheckpointCreatedEvent,
  ThreadCheckpointRestoreRequestedEvent,
  ThreadCheckpointRestoredEvent,
  ThreadCheckpointRestoreFailedEvent,
  ThreadErrorEvent,
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

/**
 * The type tags of `OrchestrationEvent`, as data. A test keeps this list and
 * the union's members in lockstep.
 */
export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.removed",
  "thread.created",
  "thread.renamed",
  "thread.archived",
  "thread.deleted",
  "thread.session.bound",
  "thread.session.lost",
  "thread.turn.requested",
  "thread.turn.started",
  "thread.turn.completed",
  "thread.turn.interrupted",
  "thread.message.queued",
  "thread.message.dequeued",
  "thread.item.upserted",
  "thread.approval.opened",
  "thread.approval.resolved",
  "thread.userInput.requested",
  "thread.userInput.resolved",
  "thread.plan.proposed",
  "thread.plan.responded",
  "thread.settings.updated",
  "thread.usage.updated",
  "thread.context.updated",
  "thread.checkpoint.created",
  "thread.checkpoint.restore.requested",
  "thread.checkpoint.restored",
  "thread.checkpoint.restore.failed",
  "thread.error",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

/** The `type` tag of each event variant, in declaration order. */
export const orchestrationEventTypes: ReadonlyArray<OrchestrationEventType> =
  OrchestrationEvent.members.map((member) => member.fields.type.literal);

// ── Read models ────────────────────────────────────────────────

/** A project as the sidebar lists it. */
export const ProjectSummary = Schema.Struct({
  projectId: ProjectId,
  name: NonEmptyString,
  workspaceRoot: NonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  threadCount: NonNegativeInt,
});
export type ProjectSummary = typeof ProjectSummary.Type;

/** A thread as the sidebar lists it: enough for the row, never the timeline. */
export const ThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: NonEmptyString,
  status: ThreadStatus,
  settings: ThreadSettings,
  preview: Schema.optional(Schema.String),
  /** True while something is waiting on the user: an approval, a question, a plan. */
  awaitingInput: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSummary = typeof ThreadSummary.Type;

/**
 * Everything the thread view needs to render from cold, at one event-log
 * position. A subscriber decodes this, then applies events with a greater
 * `sequence` than `snapshotSequence`.
 */
export const ThreadDetailSnapshot = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: NonEmptyString,
  status: ThreadStatus,
  settings: ThreadSettings,
  snapshotSequence: NonNegativeInt,
  items: Schema.Array(ItemSnapshot),
  queue: Schema.Array(QueuedMessage),
  checkpoints: Schema.Array(CheckpointSummary),
  session: Schema.NullOr(ThreadSession),
  currentTurnId: Schema.NullOr(TurnId),
  pendingApproval: Schema.NullOr(ApprovalRequest),
  pendingUserInput: Schema.NullOr(
    Schema.Struct({ requestId: RequestId, questions: Schema.Array(UserQuestion) }),
  ),
  pendingPlan: Schema.NullOr(
    Schema.Struct({
      turnId: TurnId,
      planMarkdown: Schema.String,
      planPath: Schema.optional(NonEmptyString),
    }),
  ),
  usage: Schema.NullOr(TurnUsage),
  context: Schema.NullOr(ContextWindowUsage),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDetailSnapshot = typeof ThreadDetailSnapshot.Type;

/**
 * One frame of a thread subscription.
 *
 * `synchronized` is sent once, after the snapshot or catch-up replay, so the UI
 * knows it is live rather than still loading. `resnapshot-required` is how a
 * stream gives up on incremental delivery — the client's `afterSequence` has
 * aged out, or the subscription blew its budget — and the client reacts by
 * re-subscribing from scratch instead of rendering a gap.
 */
export const ThreadStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: ThreadDetailSnapshot }),
  Schema.Struct({ kind: Schema.Literal("event"), event: OrchestrationEvent }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: NonEmptyString,
  }),
]);
export type ThreadStreamItem = typeof ThreadStreamItem.Type;

/** One frame of a thread-list subscription. */
export const ThreadListStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshotSequence: NonNegativeInt,
    threads: Schema.Array(ThreadSummary),
  }),
  Schema.Struct({ kind: Schema.Literal("upserted"), thread: ThreadSummary }),
  Schema.Struct({ kind: Schema.Literal("removed"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: NonEmptyString,
  }),
]);
export type ThreadListStreamItem = typeof ThreadListStreamItem.Type;
