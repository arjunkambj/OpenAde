/**
 * The connector-facing reactor: turns, interrupts, responses, queue drain.
 *
 * Everything here is an event reaction, never a dispatch input — the decider
 * already decided; this fiber performs the side effect the event calls for:
 *
 * - `turn.requested` → ensure the session, `handle.send(turnId, turn)`.
 * - `turn.interrupted` → `handle.interrupt(turnId)`; the turn stays in flight
 *   until the connector settles it, and this fiber settles it itself when
 *   there is no live session left to do so.
 * - `approval.resolved` / `userInput.resolved` / `plan.responded` → the
 *   matching `respond*` on the live handle, plus the plan follow-up commands
 *   spec section 8 prescribes.
 * - `settings.updated` → `handle.updateSettings` so mode/model changes reach
 *   the running session.
 * - `turn.completed` → drain the queue: dequeue the head, dispatch it as a new
 *   turn.
 * - `project.removed` → dispatch `thread.delete` for every thread under it.
 * - `thread.archived` / `thread.deleted` → close the session.
 *
 * A failing side effect records `thread.error` (and a synthetic
 * `turn.completed` when a turn was mid-flight) instead of leaving the thread
 * wedged in `running`.
 */

import { makeCommandId, makeEventId } from "@OpenAde/contracts/ids";
import type { ProjectId, RequestId, ThreadId, TurnId } from "@OpenAde/contracts/ids";
import type { ApprovalDecision } from "@OpenAde/contracts/enums";
import type {
  Attachment,
  Mention,
  OrchestrationEvent,
  PlanResponseAction,
  ThreadSettingsPatch,
} from "@OpenAde/contracts/orchestration";
import type { UserQuestionAnswer } from "@OpenAde/contracts/runtime";
import type { TurnInput } from "@OpenAde/connector-sdk/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { PlannedEvent } from "../persistence/EventStore";
import { OrchestrationEngine } from "./Engine";
import { SessionManager } from "./SessionManager";
import type { ThreadDoc } from "./state";

const systemEvent = <Type extends OrchestrationEvent["type"]>(
  threadId: ThreadId,
  type: Type,
  payload: Extract<OrchestrationEvent, { type: Type }>["payload"],
  occurredAt: string,
  causedBy: string,
): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    occurredAt,
    causationEventId: causedBy as PlannedEvent["causationEventId"],
    correlationId: causedBy,
    actor: "system",
    type,
    payload,
  }) as PlannedEvent;

export const ProviderCommandReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine;
    const sessions = yield* SessionManager;

    const dispatchSettings = (threadId: ThreadId, patch: ThreadSettingsPatch) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.settings.update",
        threadId,
        ...patch,
      });

    const dispatchTurn = (threadId: ThreadId, input: TurnInput) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.turn.start",
        threadId,
        text: input.text,
        attachments: input.attachments,
        mentions: input.mentions,
        queued: false,
      });

    /** Records a hard failure and, mid-turn, settles the turn. */
    const failThread = (threadId: ThreadId, doc: ThreadDoc, message: string, causedBy: string) =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const planned: Array<PlannedEvent> = [
          systemEvent(threadId, "thread.error", { message, fatal: true }, now, causedBy),
        ];
        if (doc.currentTurn !== null) {
          planned.push(
            systemEvent(
              threadId,
              "thread.turn.completed",
              { turnId: doc.currentTurn.turnId, stopReason: "error" },
              now,
              causedBy,
            ),
          );
        }
        yield* engine.appendThreadEvents(threadId, planned);
      });

    const dispatchDelete = (threadId: ThreadId) =>
      engine.dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.delete",
        threadId,
      });

    const react = (event: OrchestrationEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A removed project takes its threads with it, one `thread.delete` at
        // a time: that is the only path that closes their sessions and prunes
        // their checkpoints. Deleting the rows wholesale would leave connector
        // processes running against a project that no longer exists.
        if (event.streamKind === "project" && event.type === "project.removed") {
          const projectId = (event.payload as Record<string, unknown>).projectId as ProjectId;
          const docs = yield* engine.threadDocs;
          for (const doc of docs) {
            if (doc.projectId === projectId && !doc.deleted) {
              yield* dispatchDelete(doc.threadId);
            }
          }
          return;
        }
        if (event.streamKind !== "thread") {
          return;
        }
        const threadId = event.streamId as ThreadId;
        const payload = event.payload as Record<string, unknown>;

        switch (event.type) {
          case "thread.turn.requested": {
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted) {
              return;
            }
            const project = yield* engine.projectDoc(doc.projectId);
            if (project === null) {
              return;
            }
            const turnId = payload.turnId as TurnId;
            yield* sessions.ensure(doc, project.workspaceRoot).pipe(
              Effect.flatMap((handle) =>
                handle.send(turnId, {
                  text: payload.text as string,
                  attachments: (payload.attachments ?? []) as ReadonlyArray<Attachment>,
                  mentions: (payload.mentions ?? []) as ReadonlyArray<Mention>,
                }),
              ),
              Effect.catch((error) =>
                failThread(
                  threadId,
                  doc,
                  error instanceof Error ? error.message : String(error),
                  event.eventId,
                ),
              ),
            );
            return;
          }

          case "thread.session.bound": {
            // A session that binds while a turn is in-flight means we resumed
            // after a loss — re-send the turn (the turn-scoped handle dedupes
            // a turn it already has, so the fresh-session path is free).
            const doc = yield* engine.threadDoc(threadId);
            const handle = yield* sessions.handleFor(threadId);
            if (doc !== null && handle !== null && doc.currentTurn !== null) {
              yield* handle
                .send(doc.currentTurn.turnId, doc.currentTurn.input)
                .pipe(Effect.catch((error) => Effect.logWarning("resume resend failed", error)));
            }
            return;
          }

          case "thread.turn.interrupted": {
            const turnId = payload.turnId as TurnId;
            const handle = yield* sessions.handleFor(threadId);
            // The turn stays in flight until something settles it. Normally
            // that is the connector's own `turn.completed`, which the handle
            // emits once it has stopped; if there is no live session, or the
            // interrupt itself fails, nothing else ever will — so settle it
            // here rather than leave the thread stuck in `running`.
            const settled = yield* handle === null
              ? Effect.succeed(false)
              : handle.interrupt(turnId).pipe(
                  Effect.as(true),
                  Effect.catch((error) =>
                    Effect.logWarning("interrupt failed", error).pipe(Effect.as(false)),
                  ),
                );
            if (!settled) {
              yield* engine
                .appendThreadEvents(threadId, [
                  systemEvent(
                    threadId,
                    "thread.turn.completed",
                    { turnId, stopReason: "interrupted" },
                    new Date().toISOString(),
                    event.eventId,
                  ),
                ])
                .pipe(Effect.catch((error) => Effect.logWarning("interrupt settle failed", error)));
            }
            return;
          }

          case "thread.approval.resolved": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              yield* handle
                .respondToRequest(
                  payload.requestId as RequestId,
                  payload.decision as ApprovalDecision,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("respond failed", error)));
            }
            return;
          }

          case "thread.userInput.resolved": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              yield* handle
                .respondToUserInput(
                  payload.requestId as RequestId,
                  payload.answers as ReadonlyArray<UserQuestionAnswer>,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("respond failed", error)));
            }
            return;
          }

          case "thread.plan.responded": {
            const handle = yield* sessions.handleFor(threadId);
            const action = payload.action as PlanResponseAction;
            if (handle !== null) {
              yield* handle
                .respondToPlan(
                  payload.turnId as TurnId,
                  action,
                  payload.feedback as string | undefined,
                )
                .pipe(Effect.catch((error) => Effect.logWarning("plan respond failed", error)));
            }
            // Spec section 8: what each plan action does next.
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted || doc.status === "archived") {
              return;
            }
            if (action === "accept" || action === "accept-auto") {
              // Accepting leaves plan mode: without the reset the next turn
              // produces another plan instead of implementing this one.
              yield* dispatchSettings(
                threadId,
                action === "accept-auto"
                  ? { interactionMode: "default", runtimeMode: "auto-accept-edits" }
                  : { interactionMode: "default" },
              );
              yield* dispatchTurn(threadId, {
                text: "Implement the approved plan.",
                attachments: [],
                mentions: [],
              });
            } else if (action === "revise") {
              yield* dispatchSettings(threadId, { interactionMode: "plan" });
              yield* dispatchTurn(threadId, {
                text: (payload.feedback as string | undefined) ?? "Revise the plan",
                attachments: [],
                mentions: [],
              });
            }
            return;
          }

          case "thread.settings.updated": {
            const handle = yield* sessions.handleFor(threadId);
            if (handle !== null) {
              yield* handle
                .updateSettings(payload as ThreadSettingsPatch)
                .pipe(Effect.catch((error) => Effect.logWarning("updateSettings failed", error)));
            }
            return;
          }

          case "thread.turn.completed": {
            const doc = yield* engine.threadDoc(threadId);
            if (doc === null || doc.deleted || doc.status === "archived") {
              return;
            }
            const next = doc.queue[0];
            if (next === undefined) {
              return;
            }
            // Dequeue first, then dispatch — the request event lands after the
            // queue mutation so a projector replaying the stream sees the same order.
            yield* engine.appendThreadEvents(threadId, [
              systemEvent(
                threadId,
                "thread.message.dequeued",
                { queuedMessageId: next.queuedMessageId },
                new Date().toISOString(),
                event.eventId,
              ),
            ]);
            // The queued message carries the composer's whole input —
            // redispatching just the text would silently drop its
            // attachments and mentions.
            yield* dispatchTurn(threadId, next);
            return;
          }

          // An archived thread has no UI attached any more; leaving its
          // connector running keeps a process (and its token budget) alive for
          // nothing, and the supervisor would resume it after a restart.
          case "thread.archived":
          case "thread.deleted": {
            yield* sessions.close(threadId);
            return;
          }
        }
      }).pipe(
        Effect.catch((error) => Effect.logWarning("provider reactor dropped an event", error)),
      );

    // Eager subscribe: the mailbox exists before the layer finishes building,
    // so an event published immediately after `provide` is still delivered.
    const mailbox = yield* engine.subscribeEvents;
    yield* Stream.runForEach(Stream.fromSubscription(mailbox), react).pipe(Effect.forkScoped);

    // Threads a previous process left stranded: `project.removed` deletes them
    // one at a time off the event above, so a crash in the middle of that would
    // otherwise leave them in the sidebar for good, pointing at no project.
    yield* Effect.gen(function* () {
      for (const doc of yield* engine.threadDocs) {
        if (doc.deleted) {
          continue;
        }
        if ((yield* engine.projectDoc(doc.projectId)) === null) {
          yield* dispatchDelete(doc.threadId);
        }
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("orphan thread sweep failed", error)),
      Effect.forkScoped,
    );
  }),
);
