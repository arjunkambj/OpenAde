/**
 * Turning the question card's drafts into `UserQuestionAnswer`s, and deciding
 * whether they are worth sending.
 *
 * Kept out of the component so the rules are testable: an empty answer is a
 * `UserQuestionAnswer` with no options and no text, which the connector has to
 * guess at, so Submit stays disabled until every question that can be answered
 * has been.
 */

import type { UserQuestion, UserQuestionAnswer } from "@OpenAde/contracts/runtime";

export interface Draft {
  readonly optionIds: ReadonlyArray<string>;
  readonly text: string;
}

export const EMPTY_DRAFT: Draft = { optionIds: [], text: "" };

const draftFor = (drafts: Readonly<Record<string, Draft>>, question: UserQuestion): Draft =>
  drafts[question.questionId] ?? EMPTY_DRAFT;

/** Only option ids this question still offers — a draft can outlive its request. */
const pickedOptions = (question: UserQuestion, draft: Draft): ReadonlyArray<string> => {
  const offered = new Set(question.options.map((option) => option.optionId));
  return draft.optionIds.filter((id) => offered.has(id));
};

/**
 * A question is answered when an offered option is selected, or when it takes
 * freeform text and some was typed. A question that offers neither — no
 * options and no freeform field — has nothing to answer and cannot block
 * Submit.
 */
export const isAnswered = (question: UserQuestion, draft: Draft): boolean => {
  if (pickedOptions(question, draft).length > 0) {
    return true;
  }
  if (question.freeform === true) {
    return draft.text.trim().length > 0;
  }
  return question.options.length === 0;
};

export const allAnswered = (
  questions: ReadonlyArray<UserQuestion>,
  drafts: Readonly<Record<string, Draft>>,
): boolean => questions.every((question) => isAnswered(question, draftFor(drafts, question)));

export const toAnswers = (
  questions: ReadonlyArray<UserQuestion>,
  drafts: Readonly<Record<string, Draft>>,
): ReadonlyArray<UserQuestionAnswer> =>
  questions.map((question) => {
    const draft = draftFor(drafts, question);
    const text = draft.text.trim();
    return {
      questionId: question.questionId,
      optionIds: pickedOptions(question, draft),
      ...(text.length > 0 ? { text } : {}),
    };
  });

export const emptyDrafts = (questions: ReadonlyArray<UserQuestion>): Record<string, Draft> =>
  Object.fromEntries(questions.map((question) => [question.questionId, EMPTY_DRAFT]));
