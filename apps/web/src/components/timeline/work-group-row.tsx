/**
 * `work-group` — a settled turn's run of work rows folded behind one
 * disclosure: "3 tools · 4s". Failures surface in the label so a
 * broken step is visible without expanding. The body re-renders each folded
 * item through the same row dispatcher.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { DisclosureRow } from "@/components/timeline/row-shell";
import type { TimelineWorkGroupRow } from "@/components/timeline/fold";
import { TimelineItemView } from "@/components/timeline/timeline-item";
import { workGroupLabel } from "@/lib/format";
import { Layers } from "@honeyicons/react";

export function WorkGroupRow({
  group,
  childrenByParent,
}: {
  group: TimelineWorkGroupRow;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ItemSnapshot>>;
}) {
  return (
    <DisclosureRow
      rowId={group.id}
      icon={Layers}
      label={workGroupLabel(group)}
      meta={
        group.failedCount > 0 ? (
          <span className="ml-1 shrink-0 type-micro text-destructive">
            {group.failedCount} failed
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-1">
        {group.items.map((item) => (
          <TimelineItemView key={item.itemId} item={item} childrenByParent={childrenByParent} />
        ))}
      </div>
    </DisclosureRow>
  );
}
