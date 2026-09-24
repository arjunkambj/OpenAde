/**
 * `plan` — a proposed plan card. The accept/revise actions live on the
 * composer slot's interaction card; this row is the in-timeline record and
 * renders the markdown open by default.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@poseidon/ui/components/collapsible";

import { MarkdownBody } from "@/components/timeline/markdown";
import { useRowDisclosure } from "@/state/ui";
import { BookOpen, ChevronRight } from "@honeyicons/react";

export function PlanRow({ item }: { item: ItemSnapshot }) {
  const [open, setOpen] = useRowDisclosure(item.itemId, true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} variant="card">
      <CollapsibleTrigger variant="card">
        <BookOpen variant="bold" className="size-3.5 shrink-0 text-permission" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">Plan</span>
        <ChevronRight
          variant="bold"
          className="size-3.5 shrink-0 text-muted-foreground transition-reveal duration-150 ease-out group-data-open/row:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted variant="card">
        <MarkdownBody text={item.plan?.markdown ?? item.text ?? ""} id={item.itemId} />
      </CollapsibleContent>
    </Collapsible>
  );
}
