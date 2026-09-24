/**
 * The `ask_user_question` card: one `UserQuestion` per block — options as a
 * single- or multi-select, plus a freeform field when the question allows it.
 * Submit dispatches `thread.userInput.respond`; the card closes only when the
 * `thread.userInput.resolved` event clears `doc.pendingUserInput`. It stays
 * disabled until every question has an answer — an empty
 * `UserQuestionAnswer` is something the connector has to guess at.
 *
 * Keys, by default: `1`…`9` pick option N — toggle it, in a multi-select — of
 * the question whose block holds focus, else of the first question. They are
 * the `question.option.N` rows of the keybinding table, live while
 * `questionPending && !inputFocus && !dialogOpen`, so typing a digit into the
 * freeform field stays typing.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import { Input } from "@poseidon/ui/components/input";
import { cn } from "@poseidon/ui/lib/utils";
import type { RequestId, ThreadId } from "@poseidon/contracts/ids";
import { QUESTION_OPTION_COMMANDS } from "@poseidon/contracts/keybindings";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { UserQuestion } from "@poseidon/contracts/runtime";
import * as React from "react";

import {
  allAnswered,
  emptyDrafts,
  keyedQuestion,
  toAnswers,
  toggleOption,
  EMPTY_DRAFT,
  type Draft,
} from "@/components/approvals/answers";
import { CardShell } from "@/components/approvals/card-shell";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { Chat, Clock } from "@honeyicons/react";

function QuestionBlock({
  question,
  draft,
  onChange,
}: {
  readonly question: UserQuestion;
  readonly draft: Draft;
  readonly onChange: (next: Draft) => void;
}) {
  const multi = question.multiSelect === true;
  const toggle = (optionId: string) => onChange(toggleOption(question, draft, optionId));

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-question-id={question.questionId}>
      <legend className="sr-only">{question.question}</legend>
      <div className="flex min-w-0 flex-col gap-0.5">
        {question.header === undefined ? null : (
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {question.header}
          </span>
        )}
        <p className="text-sm">{question.question}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1" role={multi ? "group" : "radiogroup"}>
        {question.options.map((option) => {
          const selected = draft.optionIds.includes(option.optionId);
          return (
            <button
              key={option.optionId}
              type="button"
              role={multi ? undefined : "radio"}
              aria-checked={selected}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-xl px-2 py-1 text-left text-sm transition-colors hover:bg-hover",
                selected && "bg-hover",
              )}
              onClick={() => toggle(option.optionId)}
            >
              {multi ? (
                <Checkbox checked={selected} tabIndex={-1} className="mt-0.5" />
              ) : (
                <span
                  className={cn(
                    "mt-1 inline-block size-2.5 shrink-0 rounded-full bg-input",
                    selected && "bg-primary",
                  )}
                  aria-hidden
                />
              )}
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {question.freeform === true ? (
        <Input
          value={draft.text}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
          placeholder="Or type your own answer…"
          aria-label={`${question.question} — custom answer`}
        />
      ) : null}
    </fieldset>
  );
}

/** Answers one `question.option.N` command while mounted. */
function OptionKey({
  command,
  onPress,
}: {
  readonly command: string;
  readonly onPress: () => void;
}) {
  useKeybindingCommand(command, onPress);
  return null;
}

/** The question block that holds focus, read off the page at the keypress. */
const focusedQuestionId = (): string | undefined =>
  document.activeElement?.closest("[data-question-id]")?.getAttribute("data-question-id") ??
  undefined;

export function QuestionCard({
  threadId,
  requestId,
  questions,
}: {
  readonly threadId: ThreadId;
  readonly requestId: RequestId;
  readonly questions: ReadonlyArray<UserQuestion>;
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() => emptyDrafts(questions));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const answered = allAnswered(questions, drafts);

  const submit = () => {
    if (!answered) {
      return;
    }
    const answers = toAnswers(questions, drafts);
    setPending(true);
    setError(null);
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.userInput.respond",
      threadId,
      requestId,
      answers,
    }).then(
      (receipt) => {
        setPending(false);
        setError(receiptError(receipt, "the server rejected the response"));
      },
      () => {
        setPending(false);
        setError(DISPATCH_UNREACHABLE);
      },
    );
  };

  const pickByKey = (index: number) => {
    if (pending) {
      return;
    }
    const question = keyedQuestion(questions, focusedQuestionId());
    const option = question?.options[index];
    if (question === undefined || option === undefined) {
      return;
    }
    setDrafts((current) => ({
      ...current,
      [question.questionId]: toggleOption(
        question,
        current[question.questionId] ?? EMPTY_DRAFT,
        option.optionId,
      ),
    }));
  };

  return (
    <CardShell
      icon={Chat}
      title={questions.length === 1 ? "Question" : `${questions.length} questions`}
      hint={<Clock variant="bold" className="size-3.5" />}
      actions={
        <Button size="sm" disabled={pending || !answered} onClick={submit}>
          Submit answers
        </Button>
      }
    >
      {QUESTION_OPTION_COMMANDS.map((command, index) => (
        <OptionKey key={command} command={command} onPress={() => pickByKey(index)} />
      ))}
      {questions.map((question) => (
        <QuestionBlock
          key={question.questionId}
          question={question}
          draft={drafts[question.questionId] ?? EMPTY_DRAFT}
          onChange={(next) => setDrafts((current) => ({ ...current, [question.questionId]: next }))}
        />
      ))}
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </CardShell>
  );
}
