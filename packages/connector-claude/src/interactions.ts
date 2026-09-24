/**
 * The two tool calls that are the model talking to the user rather than
 * acting on the machine, answered from `canUseTool`:
 *
 * - **AskUserQuestion** opens Poseidon's question card (`user-input.requested`)
 *   and parks the call until the user answers (`respondToUserInput`). The
 *   answer goes back as the call's `updatedInput` (`questions.ts`), and the
 *   CLI hands the model its result. A call the CLI withdraws — its signal
 *   aborts, as on an interrupt — or a session that closes answers the card
 *   with nothing and the call `deny`. Either way `user-input.resolved` says
 *   the card is gone.
 * - **ExitPlanMode** is the plan (`plans.ts`): `onPlan` puts it on the
 *   timeline and raises the plan card, and the call is denied with a message
 *   that tells the model to stop. Nothing parks: the user's answer to the
 *   plan comes as the thread's next turn, not as this call's result.
 */

import type { RequestId } from "@poseidon/contracts/ids";
import { makeRequestId } from "@poseidon/contracts/ids";
import type { UserQuestion, UserQuestionAnswer } from "@poseidon/contracts/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { NO_PLAN, PLAN_CAPTURED, planOf, type ProposedPlan } from "./plans";
import { answeredInput, questionsOf } from "./questions";
import type { ToolPermission } from "./toolGate";
import type { PendingRuntimeEvent } from "./translate/pending";

/** What the model is told when its question was not answered. */
export const QUESTION_UNANSWERED = "The user did not answer the question.";

export interface Interactions {
  /** An AskUserQuestion call: the card, then the user's answer as the result. */
  readonly ask: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Effect.Effect<ToolPermission>;
  /** An ExitPlanMode call: the plan proposed, and the call stopped. */
  readonly proposePlan: (
    input: Record<string, unknown>,
    toolUseId: string | undefined,
  ) => Effect.Effect<ToolPermission>;
  /** The user's answers to an open card; an unknown id is ignored. */
  readonly respondToUserInput: (
    requestId: RequestId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
  /** Closes every open card unanswered — the turn or the session is over. */
  readonly releaseAll: Effect.Effect<void>;
}

interface OpenQuestion {
  readonly questions: ReadonlyArray<UserQuestion>;
  /** The answers, or null for a card closed unanswered. */
  readonly answered: Deferred.Deferred<ReadonlyArray<UserQuestionAnswer> | null>;
}

/** null once `signal` has fired — at once when it already had. */
const withdrawn = (signal: AbortSignal): Effect.Effect<null> =>
  Effect.callback<null>((resume) => {
    const onAbort = () => resume(Effect.succeed(null));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export const makeInteractions = (options: {
  readonly emit: (pending: PendingRuntimeEvent) => Effect.Effect<void>;
  /** Puts a proposed plan on the timeline and raises its card. */
  readonly onPlan: (plan: ProposedPlan, toolUseId: string | undefined) => Effect.Effect<void>;
}): Effect.Effect<Interactions> =>
  Effect.gen(function* () {
    const open = yield* Ref.make<ReadonlyMap<RequestId, OpenQuestion>>(new Map());

    /** Takes a card out of the open set; true when it was still there. */
    const take = (requestId: RequestId) =>
      Ref.modify(open, (map) => {
        if (!map.has(requestId)) return [false, map] as const;
        const next = new Map(map);
        next.delete(requestId);
        return [true, next] as const;
      });

    const resolved = (requestId: RequestId) =>
      options.emit({ type: "user-input.resolved", requestId, payload: { requestId } });

    const ask: Interactions["ask"] = (input, signal) =>
      Effect.gen(function* () {
        const questions = questionsOf(input);
        if (questions.length === 0) {
          return { behavior: "deny", message: QUESTION_UNANSWERED } as const;
        }
        const requestId = makeRequestId();
        const answered = yield* Deferred.make<ReadonlyArray<UserQuestionAnswer> | null>();
        yield* Ref.update(open, (map) => new Map(map).set(requestId, { questions, answered }));
        yield* options.emit({
          type: "user-input.requested",
          requestId,
          payload: { requestId, questions },
        });
        // Whichever comes first — the user, `releaseAll`, or the CLI
        // withdrawing the call — settles the card; an answer that landed
        // first stands.
        const first = yield* Effect.raceFirst(Deferred.await(answered), withdrawn(signal));
        yield* Deferred.succeed(answered, first);
        const answers = yield* Deferred.await(answered);
        if (yield* take(requestId)) yield* resolved(requestId);
        return answers === null
          ? ({ behavior: "deny", message: QUESTION_UNANSWERED } as const)
          : ({
              behavior: "allow",
              updatedInput: answeredInput(input, questions, answers),
            } as const);
      });

    const proposePlan: Interactions["proposePlan"] = (input, toolUseId) =>
      Effect.gen(function* () {
        const plan = planOf(input);
        if (plan === undefined) return { behavior: "deny", message: NO_PLAN } as const;
        yield* options.onPlan(plan, toolUseId);
        return { behavior: "deny", message: PLAN_CAPTURED } as const;
      });

    return {
      ask,
      proposePlan,
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const card = (yield* Ref.get(open)).get(requestId);
          if (card !== undefined) yield* Deferred.succeed(card.answered, answers);
        }),
      releaseAll: Effect.gen(function* () {
        const cards = yield* Ref.getAndSet(open, new Map() as ReadonlyMap<RequestId, OpenQuestion>);
        for (const [requestId, card] of cards) {
          yield* Deferred.succeed(card.answered, null);
          yield* resolved(requestId);
        }
      }),
    };
  });
