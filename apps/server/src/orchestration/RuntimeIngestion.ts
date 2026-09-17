/**
 * Runtime events → orchestration events, and the per-session consumer.
 *
 * `translateRuntimeEvent` is pure except for the per-session `items` map it
 * carries: `content.delta` frames fold into the item they belong to, so the
 * log gets whole `item.upserted` snapshots instead of a delta stream.
 *
 * `ingestSession` is the reactor loop: it drains a session's (turn-scoped)
 * event stream into `append`, tags each appended event with the runtime event
 * that caused it, and reports the session's end on the lifecycle channel the
 * supervisor watches.
 */

import type { ConnectorInstanceId, ConnectorKind, ItemId, ThreadId } from "@OpenAde/contracts/ids";
import { makeEventId } from "@OpenAde/contracts/ids";
import type { ItemSnapshot, RuntimeEvent } from "@OpenAde/contracts/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { TurnScopedSessionHandle } from "@OpenAde/connector-sdk/turnScopedHandle";

import type { PlannedEvent } from "../persistence/EventStore";

/** Per-session translator state — the item snapshots deltas fold into. */
export interface IngestState {
  readonly items: Map<string, ItemSnapshot>;
}

const makeIngestState = (): IngestState => ({ items: new Map() });

const base = (
  event: RuntimeEvent,
  ctx: { readonly threadId: ThreadId; readonly nextEventId: () => PlannedEvent["eventId"] },
): Pick<
  PlannedEvent,
  | "eventId"
  | "streamKind"
  | "streamId"
  | "occurredAt"
  | "causationEventId"
  | "correlationId"
  | "actor"
> => ({
  eventId: ctx.nextEventId(),
  streamKind: "thread",
  streamId: ctx.threadId,
  occurredAt: event.createdAt,
  causationEventId: event.eventId,
  correlationId: event.eventId,
  actor: "connector",
});

/**
 * One runtime event → the orchestration events it produces. `turnId` fields
 * come from the envelope — the turn-scoped handle has already stamped our
 * turnId there (spec section 9).
 */
const translateRuntimeEvent = (
  event: RuntimeEvent,
  ctx: {
    readonly threadId: ThreadId;
    readonly connectorInstanceId: ConnectorInstanceId;
    readonly connectorKind: ConnectorKind;
    readonly state: IngestState;
    readonly nextEventId?: () => PlannedEvent["eventId"];
  },
): ReadonlyArray<PlannedEvent> => {
  const at = base(event, {
    threadId: ctx.threadId,
    nextEventId: ctx.nextEventId ?? makeEventId,
  });
  const turnId = event.turnId;

  switch (event.type) {
    case "session.started":
      return [
        {
          ...at,
          type: "thread.session.bound",
          payload: {
            connectorInstanceId: ctx.connectorInstanceId,
            connectorKind: ctx.connectorKind,
            sessionRef: event.payload.sessionRef,
          },
        },
      ];

    case "session.ended":
      // The supervisor reacts through the lifecycle channel; nothing to log.
      return [];

    case "session.warning":
      return [
        {
          ...at,
          type: "thread.error",
          payload: { message: event.payload.message, fatal: false },
        },
      ];

    case "turn.started":
      return turnId === undefined
        ? []
        : [
            {
              ...at,
              type: "thread.turn.started",
              payload: { turnId },
            },
          ];

    case "turn.completed":
      return turnId === undefined
        ? []
        : [
            {
              ...at,
              type: "thread.turn.completed",
              payload: { turnId, stopReason: event.payload.stopReason },
            },
          ];

    case "turn.plan.proposed":
      return [
        {
          ...at,
          type: "thread.plan.proposed",
          payload: {
            turnId: turnId ?? event.payload.turnId,
            planMarkdown: event.payload.planMarkdown,
            ...(event.payload.planPath === undefined ? {} : { planPath: event.payload.planPath }),
          },
        },
      ];

    case "item.started":
    case "item.updated":
    case "item.completed": {
      ctx.state.items.set(event.payload.item.itemId, event.payload.item);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: {
            item: event.payload.item,
            ...(turnId === undefined ? {} : { turnId }),
          },
        },
      ];
    }

    case "content.delta": {
      const itemId = event.payload.itemId as ItemId;
      const existing = ctx.state.items.get(itemId) ?? {
        itemId,
        kind: "assistant_message" as const,
        status: "in_progress" as const,
      };
      const merged: ItemSnapshot = {
        ...existing,
        text: `${existing.text ?? ""}${event.payload.delta}`,
      };
      ctx.state.items.set(itemId, merged);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: { item: merged, ...(turnId === undefined ? {} : { turnId }) },
        },
      ];
    }

    case "request.opened":
      return [
        {
          ...at,
          type: "thread.approval.opened",
          payload: { request: event.payload.request },
        },
      ];

    case "request.resolved":
      return [
        {
          ...at,
          type: "thread.approval.resolved",
          payload: {
            requestId: event.payload.requestId,
            decision: event.payload.decision,
          },
        },
      ];

    case "user-input.requested":
      return [
        {
          ...at,
          type: "thread.userInput.requested",
          payload: {
            requestId: event.payload.requestId,
            questions: event.payload.questions,
          },
        },
      ];

    case "user-input.resolved":
      return [
        {
          ...at,
          type: "thread.userInput.resolved",
          payload: { requestId: event.payload.requestId, answers: [] },
        },
      ];

    case "task.started":
    case "task.updated":
    case "task.completed": {
      const item: ItemSnapshot = {
        itemId: event.payload.taskId as ItemId,
        kind: "task",
        status: event.payload.status,
        text: event.payload.title,
        ...(event.payload.parentItemId === undefined
          ? {}
          : { parentItemId: event.payload.parentItemId }),
      };
      ctx.state.items.set(item.itemId, item);
      return [
        {
          ...at,
          type: "thread.item.upserted",
          payload: { item, ...(turnId === undefined ? {} : { turnId }) },
        },
      ];
    }

    case "usage.updated":
      return [
        {
          ...at,
          type: "thread.usage.updated",
          payload: {
            turnId: turnId ?? event.payload.turnId,
            usage: {
              input: event.payload.input,
              output: event.payload.output,
              cacheRead: event.payload.cacheRead,
              cacheWrite: event.payload.cacheWrite,
              ...(event.payload.costUsd === undefined ? {} : { costUsd: event.payload.costUsd }),
            },
          },
        },
      ];

    case "context.updated":
      return [
        {
          ...at,
          type: "thread.context.updated",
          payload: { used: event.payload.used, limit: event.payload.limit },
        },
      ];

    case "model.changed":
      return [
        {
          ...at,
          type: "thread.settings.updated",
          payload: {
            model: event.payload.model,
            ...(event.payload.effort === undefined ? {} : { effort: event.payload.effort }),
          },
        },
      ];

    case "mcp.status.updated":
      // No read-model slot for MCP status yet; W6 owns the surface it lands on.
      return [];

    case "runtime.error":
      return [
        {
          ...at,
          type: "thread.error",
          payload: { message: event.payload.message, fatal: event.payload.fatal },
        },
      ];

    case "event.unmapped":
      // Unknown frames stay debuggability-only: the harness moved first, and
      // the raw frame lives in the connector's logs rather than the timeline.
      return [];
  }
};

/** What the session driver reports on the lifecycle channel. */
export type SessionLifecycle =
  | {
      readonly kind: "started";
      readonly threadId: ThreadId;
      readonly connectorInstanceId: ConnectorInstanceId;
    }
  | {
      readonly kind: "ended";
      readonly threadId: ThreadId;
      readonly connectorInstanceId: ConnectorInstanceId;
      readonly reason: "stopped" | "crashed" | "interrupted";
      readonly exitCode?: number;
    };

/**
 * Drains one session's events into the log. Resolves when the stream ends;
 * reports `ended` on the lifecycle channel as it goes.
 */
export const ingestSession = (
  handle: TurnScopedSessionHandle,
  ctx: {
    readonly threadId: ThreadId;
    readonly connectorInstanceId: ConnectorInstanceId;
    readonly connectorKind: ConnectorKind;
  },
  deps: {
    readonly nextEventId?: () => PlannedEvent["eventId"];
    readonly append: (
      threadId: ThreadId,
      events: ReadonlyArray<PlannedEvent>,
    ) => Effect.Effect<unknown, unknown>;
    readonly report: (lifecycle: SessionLifecycle) => Effect.Effect<unknown>;
  },
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const state = makeIngestState();
    yield* Stream.runForEach(handle.events, (event) =>
      Effect.gen(function* () {
        if (event.type === "session.ended") {
          yield* deps.report({
            kind: "ended",
            threadId: ctx.threadId,
            connectorInstanceId: ctx.connectorInstanceId,
            reason: event.payload.reason,
            ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
          });
        }
        const planned = translateRuntimeEvent(event, {
          ...ctx,
          state,
          nextEventId: deps.nextEventId,
        });
        if (planned.length > 0) {
          yield* deps.append(ctx.threadId, planned);
        }
      }),
    );
  });
