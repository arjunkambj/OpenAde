/**
 * `ask_user_question` tool input → `UserQuestion[]`.
 *
 * The recorded payload carries a `questions[]` array and nothing else
 * (`fixtures/cmd/question-tools/`), so the exact shape of a payload we have
 * not seen is a guess. The wire contract is not:
 * `questionId`, `question` and every option's `optionId`/`label` are
 * NonEmptyString (contracts/runtime.ts), and one missing field fails the
 * Schema encode at the transport, which loses the whole card.
 *
 * So nothing here trusts the payload. Ids are minted when absent, string
 * options become `{optionId, label}`, a question that only has a header uses
 * it as its text, anything with no text at all is dropped, and no input can
 * make this throw. The minted ids are ours end to end, and never go back out:
 * `describeAnswers` resolves them to the question and option text the model
 * itself wrote before the answers travel in `permissionDecisionReason`.
 */

import type {
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionOption,
} from "@poseidon/contracts/runtime";

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

/** One answer as the model can read it: the question, and what was picked. */
interface DescribedAnswer {
  readonly question: string;
  readonly selected?: ReadonlyArray<string>;
  readonly text?: string;
}

/**
 * The answers, said in the model's own words rather than ours.
 *
 * Ids are the wrong currency going back: the ones above are minted whenever
 * the payload omitted them, so `{"questionId":"q1","optionIds":["o2"]}` names
 * nothing the model ever wrote and it cannot tell which option the user chose.
 * Resolving each id against the question it came from puts the text back. An
 * id with no question or option behind it is kept as-is — better a stray id
 * than a dropped answer.
 */
export const describeAnswers = (
  questions: ReadonlyArray<UserQuestion>,
  answers: ReadonlyArray<UserQuestionAnswer>,
): ReadonlyArray<DescribedAnswer> =>
  answers.map((answer) => {
    const asked = questions.find((question) => question.questionId === answer.questionId);
    const selected = answer.optionIds.map(
      (optionId) =>
        asked?.options.find((option) => option.optionId === optionId)?.label ?? optionId,
    );
    return {
      question: asked?.question ?? answer.questionId,
      ...(selected.length === 0 ? {} : { selected }),
      ...(answer.text === undefined || answer.text === "" ? {} : { text: answer.text }),
    };
  });

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

/**
 * The hook's answer text → what the timeline should show for an answered
 * question.
 *
 * The question bridge deliberately denies `ask_user_question` and hands the
 * answers back in `permissionDecisionReason` — the harness reads them as
 * context instead of asking interactively, which is the design the recordings
 * confirm. The CLI reports that as `tool_hook_blocked`, so the row ended up
 * red and failed with the user's own answers printed as an error message,
 * followed by "Do not retry this tool". The answer is not a failure and the
 * policy sentence is addressed to the model, not to the reader.
 */
export const readableAnswers = (hookOutput: string): string => {
  const body = hookOutput.replace(/\(Blocked by hook policy\.[^)]*\)/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed)) {
    return body;
  }
  const lines = parsed.flatMap((entry) => {
    const record = asRecord(entry);
    const question = text(record, "question");
    const selected = Array.isArray(record.selected)
      ? record.selected.filter((value): value is string => typeof value === "string")
      : [];
    const free = text(record, "text");
    const answer = [...selected, ...(free === "" ? [] : [free])].join(", ");
    if (question === "" && answer === "") {
      return [];
    }
    return [question === "" ? answer : `${question} → ${answer || "(no answer)"}`];
  });
  return lines.length === 0 ? body : lines.join("\n");
};
