/**
 * The `ask_user_question` card: one `UserQuestion` per block — options as a
 * single- or multi-select, plus a freeform field when the question allows it.
 * Submit dispatches `thread.userInput.respond`; the card closes only when the
 * `thread.userInput.resolved` event clears `doc.pendingUserInput`.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Checkbox } from "@OpenAde/ui/components/checkbox";
import { Input } from "@OpenAde/ui/components/input";
import { cn } from "@OpenAde/ui/lib/utils";
import type { RequestId, ThreadId } from "@OpenAde/contracts/ids";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { UserQuestion, UserQuestionAnswer } from "@OpenAde/contracts/runtime";
import * as React from "react";

import { CardShell } from "@/components/approvals/card-shell";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { Icon } from "@/lib/icon";

interface Draft {
  readonly optionIds: ReadonlyArray<string>;
  readonly text: string;
}

const emptyDrafts = (questions: ReadonlyArray<UserQuestion>): Record<string, Draft> =>
  Object.fromEntries(questions.map((q) => [q.questionId, { optionIds: [], text: "" }]));

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
  const toggle = (optionId: string) => {
    const optionIds = multi
      ? draft.optionIds.includes(optionId)
        ? draft.optionIds.filter((id) => id !== optionId)
        : [...draft.optionIds, optionId]
      : [optionId];
    onChange({ ...draft, optionIds });
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
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
                "flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-hover",
                selected && "bg-hover",
              )}
              onClick={() => toggle(option.optionId)}
            >
              {multi ? (
                <Checkbox checked={selected} tabIndex={-1} className="mt-0.5" />
              ) : (
                <span
                  className={cn(
                    "mt-1 inline-block size-2.5 shrink-0 rounded-full border border-border",
                    selected && "border-primary bg-primary",
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

  const submit = () => {
    const answers: Array<UserQuestionAnswer> = questions.map((question) => {
      const draft = drafts[question.questionId] ?? { optionIds: [], text: "" };
      // Drafts can outlive the option list if the request was replaced —
      // intersect so only live optionIds go on the wire.
      const valid = new Set(question.options.map((option) => option.optionId));
      return {
        questionId: question.questionId,
        optionIds: draft.optionIds.filter((id) => valid.has(id)),
        ...(draft.text.trim().length > 0 ? { text: draft.text.trim() } : {}),
      };
    });
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

  return (
    <CardShell
      icon="hugeicons:message-question"
      title={questions.length === 1 ? "Question" : `${questions.length} questions`}
      hint={<Icon icon="hugeicons:hourglass" className="size-3.5" />}
      actions={
        <Button size="sm" disabled={pending} onClick={submit}>
          Submit answers
        </Button>
      }
    >
      {questions.map((question) => (
        <QuestionBlock
          key={question.questionId}
          question={question}
          draft={drafts[question.questionId] ?? { optionIds: [], text: "" }}
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
