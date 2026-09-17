/**
 * `normalizeQuestions` against the shapes the harness might plausibly send.
 *
 * The real `ask_user_question` payload is a spec 5.7 unknown, so the test is a
 * table of guesses plus the hostile cases. Every row is also checked against
 * the wire schema: a `user-input.requested` that fails to encode is a card the
 * renderer never sees, which is the failure this module exists to prevent.
 */

import { describe, expect, it } from "@effect/vitest";
import { UserQuestion } from "@OpenAde/contracts/runtime";
import * as Schema from "effect/Schema";

import { normalizeQuestions } from "./questions";

const encodes = (questions: ReadonlyArray<UserQuestion>): boolean => {
  try {
    for (const question of questions) {
      Schema.encodeUnknownSync(UserQuestion)(question);
    }
    return true;
  } catch {
    return false;
  }
};

describe("normalizeQuestions", () => {
  it("passes a conforming payload through unchanged", () => {
    const questions = normalizeQuestions({
      questions: [
        {
          questionId: "q-1",
          question: "Which database?",
          header: "Storage",
          options: [
            { optionId: "a", label: "Postgres" },
            { optionId: "b", label: "SQLite", description: "embedded" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(questions).toEqual([
      {
        questionId: "q-1",
        question: "Which database?",
        header: "Storage",
        options: [
          { optionId: "a", label: "Postgres" },
          { optionId: "b", label: "SQLite", description: "embedded" },
        ],
      },
    ]);
    expect(encodes(questions)).toBe(true);
  });

  it("mints the ids the contract insists on", () => {
    const questions = normalizeQuestions({
      questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }],
    });
    expect(questions[0]?.questionId).toBe("q1");
    expect(questions[0]?.options.map((option) => option.optionId)).toEqual(["o1", "o2"]);
    expect(encodes(questions)).toBe(true);
  });

  it("coerces string options, and reads id/text under their other names", () => {
    const questions = normalizeQuestions({
      questions: [{ id: "pick", text: "Pick one", choices: ["Yes", "No", ""] }],
    });
    expect(questions[0]?.questionId).toBe("pick");
    expect(questions[0]?.question).toBe("Pick one");
    // The empty choice is dropped: a NonEmptyString label has no honest default.
    expect(questions[0]?.options).toEqual([
      { optionId: "o1", label: "Yes" },
      { optionId: "o2", label: "No" },
    ]);
    expect(encodes(questions)).toBe(true);
  });

  it("promotes a header-only question instead of dropping it", () => {
    const questions = normalizeQuestions({ questions: [{ header: "Ready to deploy?" }] });
    expect(questions).toEqual([{ questionId: "q1", question: "Ready to deploy?", options: [] }]);
    expect(encodes(questions)).toBe(true);
  });

  it("accepts one question sent bare, as an object or as a string", () => {
    expect(normalizeQuestions({ questions: { question: "Now?" } })[0]?.question).toBe("Now?");
    expect(normalizeQuestions({ questions: "Now?" })[0]?.question).toBe("Now?");
    // No `questions` key at all: the tool input is the question.
    expect(
      normalizeQuestions({ question: "Now?", options: [{ label: "Go" }] })[0]?.options,
    ).toEqual([{ optionId: "o1", label: "Go" }]);
  });

  it("carries multiSelect and freeform through their snake_case spellings", () => {
    const questions = normalizeQuestions({
      questions: [{ question: "Which files?", multi_select: true, allow_freeform: true }],
    });
    expect(questions[0]?.multiSelect).toBe(true);
    expect(questions[0]?.freeform).toBe(true);
    expect(encodes(questions)).toBe(true);
  });

  it("drops what it cannot read and never throws", () => {
    expect(normalizeQuestions({ questions: [{ options: ["a"] }, null, 7, ""] })).toEqual([]);
    expect(normalizeQuestions(undefined)).toEqual([]);
    expect(normalizeQuestions(null)).toEqual([]);
    expect(normalizeQuestions({ questions: [] })).toEqual([]);
    // A bare string is text, and text is a question worth showing.
    expect(normalizeQuestions("anything?")).toEqual([
      { questionId: "q1", question: "anything?", options: [] },
    ]);
  });
});
