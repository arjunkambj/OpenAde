/**
 * The question and plan cards on their own: what opens, what the answer reads
 * as to the CLI, and that every way a card can end closes it exactly once.
 */

import type { RequestId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeInteractions, QUESTION_UNANSWERED } from "./interactions";
import { NO_PLAN, PLAN_CAPTURED, type ProposedPlan } from "./plans";
import type { PendingRuntimeEvent } from "./translate/pending";

const INPUT = {
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Blue", description: "Cool" },
      ],
      multiSelect: false,
    },
  ],
};

const setup = Effect.gen(function* () {
  const events: Array<PendingRuntimeEvent> = [];
  const plans: Array<[ProposedPlan, string | undefined]> = [];
  const interactions = yield* makeInteractions({
    emit: (event) => Effect.sync(() => void events.push(event)),
    onPlan: (plan, toolUseId) => Effect.sync(() => void plans.push([plan, toolUseId])),
  });
  /** The request id of the card the question opened, once it has. */
  const opened = Effect.sync(() =>
    events.find((event) => event.type === "user-input.requested"),
  ).pipe(
    Effect.flatMap((event) =>
      event?.type === "user-input.requested"
        ? Effect.succeed(event.payload.requestId)
        : Effect.fail("wait"),
    ),
    Effect.eventually,
  );
  const lifecycle = () =>
    events.map((event) => [event.type, "requestId" in event ? event.requestId : undefined]);
  return { events, plans, interactions, opened, lifecycle };
});

describe("a question", () => {
  it.effect("opens a card, and the answer comes back as the call's updated input", () =>
    Effect.gen(function* () {
      const { interactions, opened, lifecycle, events } = yield* setup;
      const answer = yield* Effect.forkChild(interactions.ask(INPUT, new AbortController().signal));
      const requestId = yield* opened;
      expect(events[0]).toMatchObject({
        type: "user-input.requested",
        payload: {
          requestId,
          questions: [{ questionId: "q1", question: "Which colour?", header: "Colour" }],
        },
      });
      yield* interactions.respondToUserInput(requestId, [{ questionId: "q1", optionIds: ["o1"] }]);
      expect(yield* Fiber.join(answer)).toEqual({
        behavior: "allow",
        updatedInput: { ...INPUT, answers: { "Which colour?": "Red" } },
      });
      expect(lifecycle()).toEqual([
        ["user-input.requested", requestId],
        ["user-input.resolved", requestId],
      ]);
    }),
  );

  it.effect("is denied and closed when the CLI withdraws the call", () =>
    Effect.gen(function* () {
      const { interactions, opened, lifecycle } = yield* setup;
      const abort = new AbortController();
      const answer = yield* Effect.forkChild(interactions.ask(INPUT, abort.signal));
      const requestId = yield* opened;
      abort.abort();
      expect(yield* Fiber.join(answer)).toEqual({
        behavior: "deny",
        message: QUESTION_UNANSWERED,
      });
      expect(lifecycle()).toEqual([
        ["user-input.requested", requestId],
        ["user-input.resolved", requestId],
      ]);
      // A late answer to a closed card changes nothing.
      yield* interactions.respondToUserInput(requestId, []);
      expect(lifecycle()).toHaveLength(2);
    }),
  );

  it.effect("is denied and closed once when the session releases its cards", () =>
    Effect.gen(function* () {
      const { interactions, opened, lifecycle } = yield* setup;
      const answer = yield* Effect.forkChild(interactions.ask(INPUT, new AbortController().signal));
      const requestId = yield* opened;
      yield* interactions.releaseAll;
      expect(yield* Fiber.join(answer)).toEqual({
        behavior: "deny",
        message: QUESTION_UNANSWERED,
      });
      expect(lifecycle()).toEqual([
        ["user-input.requested", requestId],
        ["user-input.resolved", requestId],
      ]);
    }),
  );

  it.effect("opens no card for a call with nothing to ask", () =>
    Effect.gen(function* () {
      const { interactions, events } = yield* setup;
      expect(yield* interactions.ask({ questions: [] }, new AbortController().signal)).toEqual({
        behavior: "deny",
        message: QUESTION_UNANSWERED,
      });
      expect(events).toEqual([]);
    }),
  );

  it.effect("ignores an answer to a card it never opened", () =>
    Effect.gen(function* () {
      const { interactions, events } = yield* setup;
      yield* interactions.respondToUserInput("not-open" as RequestId, []);
      expect(events).toEqual([]);
    }),
  );
});

describe("a plan", () => {
  it.effect("is handed to onPlan, and the call is stopped with the clean stop message", () =>
    Effect.gen(function* () {
      const { interactions, plans } = yield* setup;
      expect(
        yield* interactions.proposePlan(
          { plan: "# Plan", planFilePath: "/home/u/.claude/plans/a.md" },
          "toolu_1",
        ),
      ).toEqual({ behavior: "deny", message: PLAN_CAPTURED });
      expect(plans).toEqual([
        [{ markdown: "# Plan", path: "/home/u/.claude/plans/a.md" }, "toolu_1"],
      ]);
    }),
  );

  it.effect("raises no card when the call carries no plan, and asks for one", () =>
    Effect.gen(function* () {
      const { interactions, plans } = yield* setup;
      expect(yield* interactions.proposePlan({}, "toolu_1")).toEqual({
        behavior: "deny",
        message: NO_PLAN,
      });
      expect(plans).toEqual([]);
    }),
  );
});
