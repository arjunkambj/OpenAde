/**
 * The interaction-card slot above the composer input. One card at a time —
 * a pending approval outranks a question, which outranks a plan — and each
 * card stays mounted until its resolved event clears the field on the doc.
 *
 * Each card is keyed by its request: consecutive requests must not share a
 * component instance, or request #2 inherits #1's edited permission pattern,
 * option selections and open/closed toggles — and "Always allow" would then
 * persist a rule the user never saw.
 */

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { ApprovalCard } from "@/components/approvals/approval-card";
import { PlanCard } from "@/components/approvals/plan-card";
import { QuestionCard } from "@/components/approvals/question-card";

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
      <ApprovalCard
        key={doc.pendingApproval.requestId}
        threadId={threadId}
        request={doc.pendingApproval}
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
    return <PlanCard key={doc.pendingPlan.turnId} threadId={threadId} plan={doc.pendingPlan} />;
  }
  return null;
}
