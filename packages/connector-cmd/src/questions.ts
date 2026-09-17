/**
 * `ask_user_question` tool input → `UserQuestion[]`.
 *
 * Spec 5.4 records the input key as `questions[]` and nothing else, and 5.7
 * still lists "what does ask_user_question do in print mode" as unverified —
 * so the exact shape the harness sends is a guess. The wire contract is not:
 * `questionId`, `question` and every option's `optionId`/`label` are
 * NonEmptyString (contracts/runtime.ts), and one missing field fails the
 * Schema encode at the transport, which loses the whole card.
 *
 * So nothing here trusts the payload. Ids are minted when absent, string
 * options become `{optionId, label}`, a question that only has a header uses
 * it as its text, anything with no text at all is dropped, and no input can
 * make this throw. The minted ids are ours end to end — the answers go back to
 * the harness as JSON in `permissionDecisionReason`, never as its own ids.
 */

import type { UserQuestion, UserQuestionOption } from "@OpenAde/contracts/runtime";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The first non-empty string among `keys`, trimmed. */
const text = (record: Record<string, unknown>, ...keys: ReadonlyArray<string>): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
};

const flag = (record: Record<string, unknown>, ...keys: ReadonlyArray<string>): boolean => {
  for (const key of keys) {
    if (typeof record[key] === "boolean") {
      return record[key] as boolean;
    }
  }
  return false;
};

const normalizeOption = (raw: unknown, index: number): UserQuestionOption | null => {
  // "yes" is as likely as {optionId,label} — the docs name neither.
  if (typeof raw === "string" || typeof raw === "number") {
    const label = String(raw).trim();
    return label === "" ? null : { optionId: `o${index + 1}`, label };
  }
  const record = asRecord(raw);
  const label = text(record, "label", "text", "title", "name", "value", "option");
  if (label === "") {
    return null;
  }
  const description = text(record, "description", "detail", "hint");
  return {
    optionId: text(record, "optionId", "id", "optionID", "key") || `o${index + 1}`,
    label,
    ...(description === "" ? {} : { description }),
  };
};

const normalizeQuestion = (raw: unknown, index: number): UserQuestion | null => {
  // A bare string is the whole question, with no options to offer.
  const record = typeof raw === "string" ? { question: raw } : asRecord(raw);
  const header = text(record, "header", "title");
  // A question is whatever text it carries; a header-only entry still asks
  // something, so it becomes the question rather than being dropped.
  const question = text(record, "question", "prompt", "text", "query") || header;
  if (question === "") {
    return null;
  }
  const rawOptions = record.options ?? record.choices ?? record.answers;
  const options = (Array.isArray(rawOptions) ? rawOptions : [])
    .map(normalizeOption)
    .filter((option): option is UserQuestionOption => option !== null);
  return {
    questionId: text(record, "questionId", "id", "questionID", "key") || `q${index + 1}`,
    question,
    ...(header === "" || header === question ? {} : { header }),
    options,
    ...(flag(record, "multiSelect", "multi_select", "multiple") ? { multiSelect: true } : {}),
    ...(flag(record, "freeform", "free_form", "allowFreeform", "allow_freeform")
      ? { freeform: true }
      : {}),
  };
};

/**
 * The `tool_input` of an `ask_user_question` call → the questions the card
 * shows. An input that carries no recognizable question yields an empty array,
 * which the session still reports so the turn is not left waiting on a card
 * that never arrives.
 */
export const normalizeQuestions = (input: unknown): ReadonlyArray<UserQuestion> => {
  const raw = asRecord(input).questions;
  const list = Array.isArray(raw)
    ? raw
    : // One question sent bare rather than wrapped in an array — or no
      // `questions` key at all, in which case the tool input is the question.
      [raw ?? input];
  return list
    .map(normalizeQuestion)
    .filter((question): question is UserQuestion => question !== null);
};
