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
 * muted line under it naming them — they work only while focus is outside a
 * text field (see `approvals/card-keys`), which the buttons alone cannot say.
 * Once answered, the card leaves a one-line record in the timeline instead.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";
import type { ReactNode } from "react";

import { ApprovalCard } from "@/components/approvals/approval-card";
import { PlanCard } from "@/components/approvals/plan-card";
import { QuestionCard } from "@/components/approvals/question-card";

/** The card plus, when it answers keys, the line that names them. */
function DockedCard({ card, keys }: { readonly card: ReactNode; readonly keys?: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {card}
      {keys === undefined ? null : (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-xs text-muted-foreground">
          {keys}
          <span>when the input is not focused</span>
        </p>
      )}
    </div>
  );
}

const APPROVAL_KEYS = (
  <>
    <KbdGroup>
      <Kbd>1</Kbd>
      <Kbd>2</Kbd>
      <Kbd>3</Kbd>
    </KbdGroup>
    <span>to allow,</span>
    <KbdGroup>
      <Kbd>D</Kbd>
      <Kbd>Esc</Kbd>
    </KbdGroup>
    <span>to deny,</span>
  </>
);

const PLAN_KEYS = (
  <>
    <KbdGroup>
      <Kbd>1</Kbd>
      <Kbd>2</Kbd>
    </KbdGroup>
    <span>to accept,</span>
    <Kbd>3</Kbd>
    <span>to revise,</span>
  </>
);

export function PendingCard({
  threadId,
  doc,
}: {
  readonly threadId: ThreadId;
  readonly doc: ThreadDetailSnapshot | null;
}) {
  if (doc === null) {
    return null;
  }
  if (doc.pendingApproval !== null) {
    return (
      <DockedCard
        keys={APPROVAL_KEYS}
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
      <QuestionCard
        key={doc.pendingUserInput.requestId}
        threadId={threadId}
        requestId={doc.pendingUserInput.requestId}
        questions={doc.pendingUserInput.questions}
      />
    );
  }
  if (doc.pendingPlan !== null) {
    return (
      <DockedCard
        keys={PLAN_KEYS}
        card={<PlanCard key={doc.pendingPlan.turnId} threadId={threadId} plan={doc.pendingPlan} />}
      />
    );
  }
  return null;
}
