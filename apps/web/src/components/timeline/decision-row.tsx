/**
 * `decision` — what an answered approval, question or plan leaves behind once
 * its card above the composer is gone: one static line, "Allowed once · npm
 * test". A denial reads in the destructive colour; everything else is muted
 * like the work rows around it. There is no body — the request itself was the
 * card, and what it led to is the next row.
 */

import { decisionDenied, decisionLabel } from "@/components/timeline/decision-label";
import type { TimelineDecisionRow } from "@/components/timeline/fold";
import { DisclosureRow } from "@/components/timeline/row-shell";
import { cn } from "@/lib/utils";
import { type HoneyIcon, Chat, ClipboardCheck, Lock } from "@honeyicons/react";

const ICON: Readonly<Record<TimelineDecisionRow["decision"]["kind"], HoneyIcon>> = {
  approval: Lock,
  question: Chat,
  plan: ClipboardCheck,
};

export function DecisionRow({ row }: { row: TimelineDecisionRow }) {
  const label = decisionLabel(row.decision);
  return (
    <DisclosureRow
      rowId={row.id}
      icon={ICON[row.decision.kind]}
      label={
        <span title={label} className={cn(decisionDenied(row.decision) && "text-destructive")}>
          {label}
        </span>
      }
    />
  );
}
