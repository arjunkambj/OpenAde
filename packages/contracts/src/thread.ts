/**
 * The value objects a thread's commands, events and read models share: its
 * settings, the queue's messages, usage and context accounting, checkpoints,
 * the session it is bound to and the status the sidebar shows.
 *
 * `./orchestration` re-exports every one of them, so that is still where a
 * reader imports them from; they live apart only to keep that file readable.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { Effort, InteractionMode, RuntimeMode } from "./enums";
import { CheckpointId, ConnectorInstanceId, ConnectorKind, ItemId, TurnId } from "./ids";
import { Attachment, ConnectorCapabilities, TurnReference } from "./runtime";

/** A `#` file mention from the composer: a workspace-relative path. */
export const Mention = NonEmptyString;
export type Mention = typeof Mention.Type;

/**
 * The per-thread controls the header exposes.
 *
 * `connectorInstanceId` is the harness the user picked for this thread. It is
 * optional because every event written before threads could choose one lacks
 * it, and because a thread may leave the choice to routing: absent means "the
 * default rule" — the first enabled connector that is open.
 */
export const ThreadSettings = Schema.Struct({
  model: NonEmptyString,
  effort: Schema.optional(Effort),
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  connectorInstanceId: Schema.optional(ConnectorInstanceId),
});
export type ThreadSettings = typeof ThreadSettings.Type;

/** A partial update of `ThreadSettings`; absent fields are left alone. */
export const ThreadSettingsPatch = Schema.Struct({
  model: Schema.optional(NonEmptyString),
  effort: Schema.optional(Effort),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(InteractionMode),
  connectorInstanceId: Schema.optional(ConnectorInstanceId),
});
export type ThreadSettingsPatch = typeof ThreadSettingsPatch.Type;

/**
 * Whether a thread is past the point where it may change connector instance:
 * it has a bound session, a running turn, or any message of the user's. A
 * harness's session cannot be carried to another harness, so from then on the
 * way to use a different connector is a new thread. The decider and the
 * renderer both ask this, so the picker is never enabled for a switch the
 * server would refuse.
 */
export const threadLocksConnector = (thread: {
  readonly session: unknown;
  readonly items: ReadonlyArray<{ readonly kind: string }>;
  readonly currentTurnId?: unknown;
  readonly currentTurn?: unknown;
}): boolean =>
  thread.session != null ||
  thread.currentTurnId != null ||
  thread.currentTurn != null ||
  thread.items.some((item) => item.kind === "user_message");

/** What the user typed while a turn was still running. */
export const QueuedMessage = Schema.Struct({
  queuedMessageId: ItemId,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  mentions: Schema.Array(Mention),
  references: Schema.optional(Schema.Array(TurnReference)),
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

/**
 * The connector session a thread is currently bound to, if any.
 *
 * `capabilities` is what that session's harness said it can do when it
 * started — the decider reads `steering` off it to decide whether a message
 * sent mid-turn goes into the running turn or onto the queue. Optional, so a
 * session bound before the field existed still decodes; absent reads as "no
 * steering".
 */
export const ThreadSession = Schema.Struct({
  connectorInstanceId: ConnectorInstanceId,
  connectorKind: ConnectorKind,
  sessionRef: Schema.Unknown,
  capabilities: Schema.optional(ConnectorCapabilities),
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

/**
 * What a `running` thread is doing right now: `working` while a tool call,
 * a command or a file change is in flight, `thinking` otherwise — the model
 * reasoning or writing between them.
 */
export const ThreadActivity = Schema.Literals(["thinking", "working"]);
export type ThreadActivity = typeof ThreadActivity.Type;

/** What the user chose on a proposed plan. */
export const PlanResponseAction = Schema.Literals(["accept", "accept-auto", "revise"]);
export type PlanResponseAction = typeof PlanResponseAction.Type;
