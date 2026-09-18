/**
 * Answering the harness's PreToolUse hook.
 *
 * Every tool call the model makes arrives here as an HTTP post the hook script
 * made and is blocking on. Three answers are possible and the harness applies
 * whichever comes back: allow, deny, or — the interesting one — park until the
 * user decides, which is what turns a tool call into an approval card and back.
 *
 * `ask_user_question` takes the same road for a different reason. Print mode has
 * no interactive channel, so the question is shown as a card, the answers are
 * collected, and the tool is *denied* with those answers as its reason: the
 * model reads them as context instead of waiting for a prompt that will never
 * come (spec section 8).
 *
 * A dead process leaves every one of those posts parked, so `releasePending` is
 * the other half: it answers each of them rather than letting the hook sit to
 * its 590-second ceiling.
 */

import type { ApprovalDecision } from "@OpenAde/contracts/enums";
import type { RequestId, ThreadId } from "@OpenAde/contracts/ids";
import { makeRequestId } from "@OpenAde/contracts/ids";
import type { ThreadSettings } from "@OpenAde/contracts/orchestration";
import type { ApprovalRequest, UserQuestion, UserQuestionAnswer } from "@OpenAde/contracts/runtime";
import type { ConnectorServices } from "@OpenAde/connector-sdk/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { approvalKindFor, patternSuggestionFor } from "./approvals";
import type { PendingRuntimeEvent } from "./items";
import { describeAnswers, normalizeQuestions } from "./questions";

interface PendingApproval {
  readonly released: Deferred.Deferred<ApprovalDecision>;
}

interface PendingUserInput {
  readonly released: Deferred.Deferred<ReadonlyArray<UserQuestionAnswer>>;
  /** What was asked, so the answer can go back as text rather than as our ids. */
  readonly questions: ReadonlyArray<UserQuestion>;
}

export interface HookAnswerer {
  /** One PreToolUse post → the `hookSpecificOutput` the harness applies. */
  readonly onHookPost: (body: unknown) => Effect.Effect<unknown>;
  /** Answers every parked post — the process that asked them is gone. */
  readonly releasePending: Effect.Effect<void>;
  /** The user's decision on an open approval. */
  readonly respondToRequest: (
    requestId: RequestId,
    decision: ApprovalDecision,
  ) => Effect.Effect<void>;
  /** The user's answers to an open question card. */
  readonly respondToUserInput: (
    requestId: RequestId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
}

export const makeHookAnswerer = (options: {
  readonly threadId: ThreadId;
  readonly services: ConnectorServices;
  /** The thread's current settings — read per post, not captured. */
  readonly settings: Effect.Effect<ThreadSettings>;
  readonly emit: (pending: PendingRuntimeEvent) => Effect.Effect<void>;
}): Effect.Effect<HookAnswerer> =>
  Effect.gen(function* () {
    const pendingApprovals = yield* Ref.make(new Map<RequestId, PendingApproval>());
    const pendingUserInputs = yield* Ref.make(new Map<RequestId, PendingUserInput>());
    const emit = options.emit;

    /**
     * A dead process leaves hook posts parked — every outstanding approval is
     * released with `deny` (and `user-input` with empty answers) so the bridge
     * replies instead of hanging to the 590s ceiling.
     */
    const releasePending = Effect.gen(function* () {
      const approvals = yield* Ref.getAndSet(pendingApprovals, new Map());
      for (const [requestId, pending] of approvals) {
        yield* Deferred.succeed(pending.released, "deny" as const);
        yield* emit({
          type: "request.resolved",
          requestId,
          payload: { requestId, decision: "deny" },
        });
      }
      const inputs = yield* Ref.getAndSet(pendingUserInputs, new Map());
      for (const [requestId, pending] of inputs) {
        yield* Deferred.succeed(pending.released, []);
        yield* emit({ type: "user-input.resolved", requestId, payload: { requestId } });
      }
    });

    /**
     * Answers a PreToolUse post for this session: asks the permission engine,
     * and on "prompt" opens a request and parks until `respondToRequest`
     * resolves it. The hook script turns the reply into `permissionDecision`.
     */
    const onHookPost = (body: unknown): Effect.Effect<unknown> =>
      Effect.gen(function* () {
        const record = body as {
          readonly tool_use_id?: string;
          readonly tool_name?: string;
          readonly tool_input?: unknown;
          readonly hook_event_name?: string;
        };
        const toolName = record.tool_name ?? "unknown";
        // The harness's tool_use_id is not a UUIDv7 — the wire ids are ours.
        const requestId = makeRequestId();

        if (record.tool_name === "ask_user_question") {
          // The payload shape is a 5.7 unknown, and the wire schema is not
          // forgiving — normalize rather than cast, or one unexpected field
          // fails the encode and the card never reaches the renderer.
          const questions = normalizeQuestions(record.tool_input);
          const released = yield* Deferred.make<ReadonlyArray<UserQuestionAnswer>>();
          yield* Ref.update(pendingUserInputs, (map) =>
            new Map(map).set(requestId, { released, questions }),
          );
          yield* emit({
            type: "user-input.requested",
            requestId,
            payload: { requestId, questions },
          });
          const answers = yield* Deferred.await(released);
          yield* Ref.update(pendingUserInputs, (map) => {
            const next = new Map(map);
            next.delete(requestId);
            return next;
          });
          yield* emit({ type: "user-input.resolved", requestId, payload: { requestId } });
          // Deny the tool and hand the answers back as the reason — the
          // harness reads them as context instead of asking interactively.
          // In the model's own words: our ids mean nothing on its side.
          return {
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: JSON.stringify(describeAnswers(questions, answers)),
            },
          };
        }

        const settings = yield* options.settings;
        const input = record.tool_input ?? {};
        const request: ApprovalRequest = {
          requestId,
          kind: approvalKindFor(toolName),
          toolName,
          input,
          patternSuggestion: patternSuggestionFor(toolName, input),
          description: toolName,
        };
        const decision = yield* options.services.permissions.decide({
          request,
          threadId: options.threadId,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
        });
        if (decision === "allow") {
          return { hookSpecificOutput: { permissionDecision: "allow" } };
        }
        if (decision === "deny") {
          return {
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: "denied by OpenAde permission rules",
            },
          };
        }
        // prompt → the user decides via thread.approval.respond.
        const released = yield* Deferred.make<ApprovalDecision>();
        yield* Ref.update(pendingApprovals, (map) => new Map(map).set(requestId, { released }));
        yield* emit({ type: "request.opened", requestId, payload: { request } });
        const answer = yield* Deferred.await(released);
        yield* Ref.update(pendingApprovals, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
        yield* emit({
          type: "request.resolved",
          requestId,
          payload: { requestId, decision: answer },
        });
        return {
          hookSpecificOutput: {
            permissionDecision: answer === "deny" ? "deny" : "allow",
            permissionDecisionReason: `decided ${answer} via OpenAde`,
          },
        };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            // A hook error must never let a tool run — deny is the safe answer.
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: "hook bridge error",
            },
          }),
        ),
      );

    return {
      onHookPost,
      releasePending,
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovals)).get(requestId);
          if (pending === undefined) return;
          yield* Deferred.succeed(pending.released, decision);
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputs)).get(requestId);
          if (pending === undefined) return;
          yield* Deferred.succeed(pending.released, answers);
        }),
    };
  });
