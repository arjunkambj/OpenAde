/**
 * AskUserQuestion's input as OpenAde's question card, and the user's answers
 * as the `updatedInput` the CLI reads: keyed by question text, labels joined.
 */

import { describe, expect, it } from "vitest";

import { answeredInput, answersFor, questionsOf } from "./questions";

const INPUT = {
  questions: [
    {
      question: "Which colour should colour.txt hold?",
      header: "Colour",
      options: [
        { label: "Red", description: "A warm colour" },
        { label: "Blue", description: "A cool colour" },
      ],
      multiSelect: false,
    },
    {
      question: "Which extras?",
      header: "Extras",
      options: [
        { label: "Newline", description: "" },
        { label: "Comment", description: "A leading comment" },
      ],
      multiSelect: true,
    },
  ],
};

describe("questionsOf", () => {
  it("mints ids by position and keeps header, options and multiSelect, all freeform", () => {
    expect(questionsOf(INPUT)).toEqual([
      {
        questionId: "q1",
        question: "Which colour should colour.txt hold?",
        header: "Colour",
        options: [
          { optionId: "o1", label: "Red", description: "A warm colour" },
          { optionId: "o2", label: "Blue", description: "A cool colour" },
        ],
        freeform: true,
      },
      {
        questionId: "q2",
        question: "Which extras?",
        header: "Extras",
        options: [
          { optionId: "o1", label: "Newline" },
          { optionId: "o2", label: "Comment", description: "A leading comment" },
        ],
        multiSelect: true,
        freeform: true,
      },
    ]);
  });

  it("drops what the card cannot show, and keeps the rest in place", () => {
    const questions = questionsOf({
      questions: [
        { question: "  ", options: [] },
        { question: "Go?", options: [{ label: "" }, { label: "Yes" }, "No"] },
      ],
    });
    expect(questions).toEqual([
      {
        questionId: "q2",
        question: "Go?",
        options: [{ optionId: "o2", label: "Yes" }],
        freeform: true,
      },
    ]);
    expect(questionsOf(undefined)).toEqual([]);
    expect(questionsOf({ questions: "Go?" })).toEqual([]);
  });
});

describe("answersFor", () => {
  const questions = questionsOf(INPUT);

  it("keys each answer by the question's text, labels joined by a comma", () => {
    expect(
      answersFor(questions, [
        { questionId: "q1", optionIds: ["o2"] },
        { questionId: "q2", optionIds: ["o1", "o2"] },
      ]),
    ).toEqual({
      "Which colour should colour.txt hold?": "Blue",
      "Which extras?": "Newline, Comment",
    });
  });

  it("puts the user's own text after any chosen labels", () => {
    expect(
      answersFor(questions, [
        { questionId: "q1", optionIds: [], text: " Green " },
        { questionId: "q2", optionIds: ["o2"], text: "and a tab" },
      ]),
    ).toEqual({
      "Which colour should colour.txt hold?": "Green",
      "Which extras?": "Comment, and a tab",
    });
  });

  it("leaves out empty answers, unknown questions and unknown options", () => {
    expect(
      answersFor(questions, [
        { questionId: "q1", optionIds: ["o9"] },
        { questionId: "q2", optionIds: [], text: "   " },
        { questionId: "q7", optionIds: ["o1"] },
      ]),
    ).toEqual({});
  });
});

describe("answeredInput", () => {
  it("is the call's own input with the answers added", () => {
    const questions = questionsOf(INPUT);
    expect(answeredInput(INPUT, questions, [{ questionId: "q1", optionIds: ["o1"] }])).toEqual({
      ...INPUT,
      answers: { "Which colour should colour.txt hold?": "Red" },
    });
  });
});
