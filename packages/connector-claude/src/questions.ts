/**
 * AskUserQuestion, between the CLI's shape and OpenAde's question card.
 *
 * The model asks one to four questions, each with a short `header`, two to
 * four options (a `label` and a `description`) and `multiSelect`. The CLI
 * always lets the user type an answer of their own instead ("Other"), so
 * every question is `freeform`. The card's ids are ours: a question is `q<n>`
 * and an option `o<n>`, by position, since the CLI gives neither an id.
 *
 * The answer goes back as the call's `updatedInput`: the questions as asked,
 * plus `answers`, keyed by each question's own text — that is how the CLI
 * matches an answer to its question — with the chosen labels joined by ", ",
 * the user's own text after them. A question the user left unanswered has no
 * key. The tool's result, which the model reads, is the CLI's rendering of
 * that map.
 */

import type {
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionOption,
} from "@OpenAde/contracts/runtime";

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The raw question entries of an AskUserQuestion input. */
const entriesOf = (input: unknown): ReadonlyArray<unknown> => {
  const questions = asRecord(input).questions;
  return Array.isArray(questions) ? questions : [];
};

const optionsOf = (raw: unknown): Array<UserQuestionOption> =>
  (Array.isArray(raw) ? raw : []).flatMap((entry, index): Array<UserQuestionOption> => {
    const option = asRecord(entry);
    const label = textOf(option.label);
    if (label === "") return [];
    const description = textOf(option.description);
    return [{ optionId: `o${index + 1}`, label, ...(description === "" ? {} : { description }) }];
  });

/**
 * The card's questions for an AskUserQuestion input. An entry with no question
 * text is dropped — the contract needs one, and a card cannot ask nothing —
 * but it keeps its place, so `q<n>` still names the n-th question asked.
 */
export const questionsOf = (input: unknown): ReadonlyArray<UserQuestion> =>
  entriesOf(input).flatMap((entry, index): Array<UserQuestion> => {
    const raw = asRecord(entry);
    const question = textOf(raw.question);
    if (question === "") return [];
    const header = textOf(raw.header);
    return [
      {
        questionId: `q${index + 1}`,
        question,
        ...(header === "" ? {} : { header }),
        options: optionsOf(raw.options),
        ...(raw.multiSelect === true ? { multiSelect: true } : {}),
        freeform: true,
      },
    ];
  });

/**
 * The `answers` map the CLI reads: question text → the chosen labels and the
 * user's own text, joined by ", ". An option id the question does not have is
 * dropped; an answer to a question that was not asked, or with nothing in it,
 * gives no key.
 */
export const answersFor = (
  questions: ReadonlyArray<UserQuestion>,
  answers: ReadonlyArray<UserQuestionAnswer>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const answer of answers) {
    const asked = questions.find((question) => question.questionId === answer.questionId);
    if (asked === undefined) continue;
    const labels = answer.optionIds.flatMap((optionId) => {
      const option = asked.options.find((candidate) => candidate.optionId === optionId);
      return option === undefined ? [] : [option.label];
    });
    const own = answer.text?.trim() ?? "";
    const parts = own === "" ? labels : [...labels, own];
    if (parts.length > 0) out[asked.question] = parts.join(", ");
  }
  return out;
};

/** The AskUserQuestion call's input with the user's answers added. */
export const answeredInput = (
  input: Readonly<Record<string, unknown>>,
  questions: ReadonlyArray<UserQuestion>,
  answers: ReadonlyArray<UserQuestionAnswer>,
): Record<string, unknown> => ({ ...input, answers: answersFor(questions, answers) });
