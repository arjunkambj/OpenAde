/**
 * Shared chrome for work rows: an icon, a one-line label, optional trailing
 * metadata, and a collapsible body. Disclosure state lives in
 * `rowDisclosureAtom` keyed by item id so virtualization can recycle the row
 * without losing it. Rows without a body render as a static line instead of a
 * disabled disclosure.
 */

import type { ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@OpenAde/ui/components/collapsible";
import type { ItemStatus } from "@OpenAde/contracts/runtime";

import { cn } from "@/lib/utils";
import { useRowDisclosure } from "@/state/ui";
import { type HoneyIcon, AlertTriangle, ChevronRight, Spinner } from "@honeyicons/react";

function ItemStatusIcon({ status }: { status: ItemStatus }) {
  if (status === "in_progress") {
    return <Spinner variant="bold" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (status === "failed") {
    return <AlertTriangle variant="bold" className="size-3.5 shrink-0 text-destructive" />;
  }
  return null;
}

const triggerIconClass = "size-3.5 text-muted-foreground transition-opacity duration-150 ease-out";

export function DisclosureRow({
  rowId,
  icon: Glyph,
  label,
  meta,
  status,
  defaultOpen = false,
  children,
}: {
  rowId: string;
  icon: HoneyIcon;
  label: ReactNode;
  meta?: ReactNode;
  status?: ItemStatus;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useRowDisclosure(rowId, defaultOpen);
  const expandable = children !== undefined && children !== null;

  if (!expandable) {
    return (
      <div className="flex min-h-6 items-center gap-2 py-0.5 type-body leading-compact text-muted-foreground">
        <Glyph variant="bold" className={triggerIconClass} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ItemStatusIcon status={status ?? "completed"} />
        {meta}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/row">
      <CollapsibleTrigger variant="summary">
        <span className="relative size-3.5 shrink-0">
          <ChevronRight
            variant="bold"
            className={cn(
              triggerIconClass,
              "absolute inset-0 opacity-0 transition-reveal group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100 group-data-open/row:rotate-90 group-data-open/row:opacity-100",
            )}
          />
          <Glyph
            variant="bold"
            className={cn(
              triggerIconClass,
              "group-hover/summary:opacity-0 group-focus-visible/summary:opacity-0 group-data-open/row:opacity-0",
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ItemStatusIcon status={status ?? "completed"} />
        {meta}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted variant="indented" className="ml-1.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A `<pre>` block for command output and tool payloads. */
export function MonoBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-prose whitespace-pre-wrap text-foreground",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/** Pretty-printed `unknown` payloads — input/output objects on tool rows. */
export function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    text = String(value);
  }
  return <MonoBlock>{text}</MonoBlock>;
}
