/**
 * `plan` — a proposed plan card. The accept/revise actions are the composer
 * slot's interaction card (W5); this row is the in-timeline record and renders
 * the markdown open by default.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@OpenAde/ui/components/collapsible";

import { MarkdownBody } from "@/components/timeline/markdown";
import { Icon } from "@/lib/icon";
import { useRowDisclosure } from "@/state/ui";

export function PlanRow({ item }: { item: ItemSnapshot }) {
  const [open, setOpen] = useRowDisclosure(item.itemId, true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} variant="card">
      <CollapsibleTrigger variant="card">
        <Icon icon="hugeicons:book-open-01" className="size-3.5 shrink-0 text-permission" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">Plan</span>
        <Icon
          icon="hugeicons:arrow-right-01"
          className="size-3.5 shrink-0 text-muted-foreground transition-reveal duration-150 ease-out group-data-open/row:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted variant="card">
        <MarkdownBody text={item.plan?.markdown ?? item.text ?? ""} />
      </CollapsibleContent>
    </Collapsible>
  );
}
