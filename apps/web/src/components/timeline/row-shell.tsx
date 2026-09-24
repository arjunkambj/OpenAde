/**
 * Shared chrome for work rows: an icon, a one-line label, optional trailing
 * metadata, and a collapsible body. Disclosure state lives in
 * `rowDisclosureAtom` keyed by item id so virtualization can recycle the row
 * without losing it. Rows without a body render as a static line instead of a
 * disabled disclosure.
 *
 * A label that holds a control of its own — a file chip — cannot sit inside
 * the trigger, which is a button. Such a row passes `triggerLabel`: the
 * trigger then holds the icon alone, named by that label, and stretches under
 * the whole line, so a click anywhere but the chip still toggles the row.
 *
 * A row that opens other rows rather than a body of its own (a settled turn's
 * fold, whose rows the list renders below it) passes `opensRows`: it toggles
 * like any other, with no panel.
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
  triggerLabel,
  opensRows = false,
  children,
}: {
  rowId: string;
  icon: HoneyIcon;
  label: ReactNode;
  meta?: ReactNode;
  status?: ItemStatus;
  defaultOpen?: boolean;
  /** The trigger's name when `label` holds its own controls (see above). */
  triggerLabel?: string;
  /** The toggle opens rows rendered outside this one, so it has no body. */
  opensRows?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useRowDisclosure(rowId, defaultOpen);
  const hasBody = children !== undefined && children !== null;
  const expandable = hasBody || opensRows;

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

  const glyphs = (
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
  );
  const content = hasBody ? (
    <CollapsibleContent keepMounted variant="indented" className="ml-1.5">
      {children}
    </CollapsibleContent>
  ) : null;

  if (triggerLabel !== undefined) {
    // The label's controls are positioned, so they paint above the trigger's
    // stretched hit area; its plain text does not, and clicks through to it.
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="group/row">
        <div className="relative flex min-h-6 items-center gap-2 py-0.5 type-body leading-compact text-muted-foreground transition-colors duration-150 ease-out hover:text-sidebar-foreground">
          <CollapsibleTrigger
            variant="summary"
            aria-label={triggerLabel}
            className="static min-h-0 w-auto shrink-0 after:absolute after:inset-0"
          >
            {glyphs}
          </CollapsibleTrigger>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ItemStatusIcon status={status ?? "completed"} />
          {meta}
        </div>
        {content}
      </Collapsible>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/row">
      <CollapsibleTrigger variant="summary">
        {glyphs}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ItemStatusIcon status={status ?? "completed"} />
        {meta}
      </CollapsibleTrigger>
      {content}
    </Collapsible>
  );
}

/** "1 failed" in the destructive colour beside a fold's label, or nothing. */
export function FailedCount({ count }: { count: number }) {
  if (count === 0) {
    return null;
  }
  return <span className="ml-1 shrink-0 type-micro text-destructive">{count} failed</span>;
}

/** A `<pre>` block for command output and tool payloads. */
export function MonoBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-prose whitespace-pre-wrap text-foreground",
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
