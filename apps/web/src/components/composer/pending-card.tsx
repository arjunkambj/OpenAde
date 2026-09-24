/**
 * The interaction-card slot above the composer input. One card at a time —
 * a pending approval outranks a question, which outranks a plan — and each
 * card stays mounted until its resolved event clears the field on the doc.
 *
 * Each card is keyed by its request: consecutive requests must not share a
 * component instance, or request #2 inherits #1's edited permission pattern,
 * option selections and open/closed toggles — and "Always allow" would then
 * persist a rule the user never saw.
 *
 * The card spans the composer column, and a card that answers keys gets a
 * muted line under it naming them, read from the live keybinding table so a
 * rebound key is what it shows. They work only while focus is outside a text
 * field — their `when` clauses say so — which the buttons alone cannot say.
 * Once answered, the card leaves a one-line record in the timeline instead.
 *
 * This is also what publishes `approvalPending`, `questionPending` and
 * `planPending` for those clauses: true for exactly the card on screen, so at
 * most one of them holds and the three card families may share `1`–`3`.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import { QUESTION_OPTION_COMMANDS } from "@poseidon/contracts/keybindings";
import type { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { ReactNode } from "react";

import { ApprovalCard } from "@/components/approvals/approval-card";
import { PlanCard } from "@/components/approvals/plan-card";
import { QuestionCard } from "@/components/approvals/question-card";
import { CommandKeys, useCommandKeycaps, useKeybindingFlag } from "@/lib/shortcuts";

/** One phrase of the key line: the chords bound to `commands`, then what they do. */
interface KeyPhrase {
  readonly commands: ReadonlyArray<string>;
  readonly does: string;
}

function KeyLine({ phrases }: { readonly phrases: ReadonlyArray<KeyPhrase> }) {
  const bound = useCommandKeycaps(phrases.flatMap((phrase) => phrase.commands));
  if (bound.length === 0) {
    return null;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-xs text-muted-foreground">
      {phrases.map((phrase) => (
        <PhraseKeys key={phrase.does} phrase={phrase} />
      ))}
      <span>when the input is not focused</span>
    </p>
  );
}

function PhraseKeys({ phrase }: { readonly phrase: KeyPhrase }) {
  const chords = useCommandKeycaps(phrase.commands);
  if (chords.length === 0) {
    return null;
  }
  return (
    <>
      <CommandKeys commands={phrase.commands} />
      <span>{phrase.does},</span>
    </>
  );
}

/** The card plus, when it answers keys, the line that names them. */
function DockedCard({
  card,
  phrases,
}: {
  readonly card: ReactNode;
  readonly phrases: ReadonlyArray<KeyPhrase>;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {card}
      <KeyLine phrases={phrases} />
    </div>
  );
}

const APPROVAL_PHRASES: ReadonlyArray<KeyPhrase> = [
  {
    commands: ["approval.allowOnce", "approval.allowSession", "approval.allowAlways"],
    does: "to allow",
  },
  { commands: ["approval.deny"], does: "to deny" },
];

const PLAN_PHRASES: ReadonlyArray<KeyPhrase> = [
  { commands: ["plan.accept", "plan.acceptAndRun"], does: "to accept" },
  { commands: ["plan.revise"], does: "to revise" },
];

/** Number keys for as many options as the widest question offers. */
const questionPhrases = (
  questions: ReadonlyArray<{ readonly options: ReadonlyArray<unknown> }>,
): ReadonlyArray<KeyPhrase> => {
  const widest = Math.max(0, ...questions.map((question) => question.options.length));
  return [{ commands: QUESTION_OPTION_COMMANDS.slice(0, widest), does: "to pick an option" }];
};

type ShownCard = "approval" | "question" | "plan" | null;

const shownCard = (doc: ThreadDetailSnapshot | null): ShownCard =>
  doc === null
    ? null
    : doc.pendingApproval !== null
      ? "approval"
      : doc.pendingUserInput !== null
        ? "question"
        : doc.pendingPlan !== null
          ? "plan"
          : null;

export function PendingCard({
  threadId,
  doc,
}: {
  readonly threadId: ThreadId;
  readonly doc: ThreadDetailSnapshot | null;
}) {
  const shown = shownCard(doc);
  useKeybindingFlag("approvalPending", shown === "approval");
  useKeybindingFlag("questionPending", shown === "question");
  useKeybindingFlag("planPending", shown === "plan");
  if (doc === null) {
    return null;
  }
  if (doc.pendingApproval !== null) {
    return (
      <DockedCard
        phrases={APPROVAL_PHRASES}
        card={
          <ApprovalCard
            key={doc.pendingApproval.requestId}
            threadId={threadId}
            request={doc.pendingApproval}
          />
        }
      />
    );
  }
  if (doc.pendingUserInput !== null) {
    return (
      <DockedCard
        phrases={questionPhrases(doc.pendingUserInput.questions)}
        card={
          <QuestionCard
            key={doc.pendingUserInput.requestId}
            threadId={threadId}
            requestId={doc.pendingUserInput.requestId}
            questions={doc.pendingUserInput.questions}
          />
        }
      />
    );
  }
  if (doc.pendingPlan !== null) {
    return (
      <DockedCard
        phrases={PLAN_PHRASES}
        card={<PlanCard key={doc.pendingPlan.turnId} threadId={threadId} plan={doc.pendingPlan} />}
      />
    );
  }
  return null;
}
