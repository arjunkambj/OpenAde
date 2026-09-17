/**
 * The interaction-card slot above the composer input. One card at a time —
 * a pending approval outranks a question, which outranks a plan — and each
 * card stays mounted until its resolved event clears the field on the doc.
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
    return <ApprovalCard threadId={threadId} request={doc.pendingApproval} />;
  }
  if (doc.pendingUserInput !== null) {
    return (
      <QuestionCard
        threadId={threadId}
        requestId={doc.pendingUserInput.requestId}
        questions={doc.pendingUserInput.questions}
      />
    );
  }
  if (doc.pendingPlan !== null) {
    return <PlanCard threadId={threadId} plan={doc.pendingPlan} />;
  }
  return null;
}
