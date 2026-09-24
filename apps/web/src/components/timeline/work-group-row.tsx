/**
 * `work-group` — a run of work rows folded behind one disclosure that says
 * what the run did: "Ran 2 commands, edited 1 file", or "Thought for 2s" for
 * reasoning alone (`work-summary.ts`). Failures surface beside the label so a
 * broken step is visible without expanding. The body re-renders each folded
 * item through the same row dispatcher.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import type { TimelineWorkGroupRow } from "@/components/timeline/fold";
import { DisclosureRow, FailedCount } from "@/components/timeline/row-shell";
import { TimelineItemView } from "@/components/timeline/timeline-item";
import { withFailures, workGroupLabel } from "@/components/timeline/work-summary";
import { Layers } from "@honeyicons/react";

export function WorkGroupRow({
  group,
  childrenByParent,
}: {
  group: TimelineWorkGroupRow;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  const label = workGroupLabel(group.items, group.durationMs);
  return (
    <DisclosureRow
      rowId={group.id}
      icon={Layers}
      label={<span title={withFailures(label, group.failedCount)}>{label}</span>}
      meta={<FailedCount count={group.failedCount} />}
    >
      <div className="flex flex-col gap-1">
        {group.items.map((item) => (
          <TimelineItemView key={item.itemId} item={item} childrenByParent={childrenByParent} />
        ))}
      </div>
    </DisclosureRow>
  );
}
