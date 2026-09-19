import { describe, expect, it } from "vitest";
import type { UserQuestion } from "@OpenAde/contracts/runtime";

import { allAnswered, emptyDrafts, isAnswered, toAnswers, EMPTY_DRAFT } from "./answers";

const choice: UserQuestion = {
  questionId: "q1",
  question: "Which surface?",
  options: [
    { optionId: "a", label: "Composer" },
    { optionId: "b", label: "Toolbar" },
  ],
};

const freeform: UserQuestion = { ...choice, questionId: "q2", freeform: true };

const nothingToAnswer: UserQuestion = { questionId: "q3", question: "Noted.", options: [] };

describe("isAnswered", () => {
  it("is false while nothing is selected", () => {
    expect(isAnswered(choice, EMPTY_DRAFT)).toBe(false);
  });

  it("is true once an offered option is selected", () => {
    expect(isAnswered(choice, { optionIds: ["a"], text: "" })).toBe(true);
  });

  it("ignores option ids the question no longer offers", () => {
    expect(isAnswered(choice, { optionIds: ["gone"], text: "" })).toBe(false);
  });

  it("accepts freeform text only where the question allows it", () => {
    expect(isAnswered(freeform, { optionIds: [], text: "  something " })).toBe(true);
    expect(isAnswered(choice, { optionIds: [], text: "something" })).toBe(false);
  });

  it("does not count whitespace as freeform text", () => {
    expect(isAnswered(freeform, { optionIds: [], text: "   " })).toBe(false);
  });

  it("does not block on a question that offers nothing to answer", () => {
    expect(isAnswered(nothingToAnswer, EMPTY_DRAFT)).toBe(true);
  });
});

describe("allAnswered", () => {
  it("needs every question answered", () => {
    const drafts = emptyDrafts([choice, freeform]);
    expect(allAnswered([choice, freeform], drafts)).toBe(false);
    expect(allAnswered([choice, freeform], { ...drafts, q1: { optionIds: ["a"], text: "" } })).toBe(
      false,
    );
    expect(
      allAnswered([choice, freeform], {
        q1: { optionIds: ["a"], text: "" },
        q2: { optionIds: ["b"], text: "" },
      }),
    ).toBe(true);
  });

  it("treats a missing draft as empty rather than throwing", () => {
    expect(allAnswered([choice], {})).toBe(false);
  });
});

describe("toAnswers", () => {
  it("drops stale option ids and trims the text", () => {
    expect(toAnswers([freeform], { q2: { optionIds: ["a", "gone"], text: "  hi  " } })).toEqual([
      { questionId: "q2", optionIds: ["a"], text: "hi" },
    ]);
  });

  it("leaves text off when none was typed", () => {
    expect(toAnswers([choice], { q1: { optionIds: ["b"], text: "   " } })).toEqual([
      { questionId: "q1", optionIds: ["b"] },
    ]);
  });
});
