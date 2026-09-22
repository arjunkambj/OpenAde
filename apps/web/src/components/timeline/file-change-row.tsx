/**
 * `file_change` — path chip + change kind, with the unified diff rendered
 * inline through the worker pool when the item carries one.
 */

import type { ItemSnapshot } from "@OpenAde/contracts/runtime";

import { InlineDiff } from "@/components/timeline/diff-pool";
import { fileChangeFallbackLabel } from "@/components/timeline/file-change";
import { DisclosureRow } from "@/components/timeline/row-shell";
import { diffStats } from "@/lib/diff-stats";
import { cn } from "@/lib/utils";
import { useRowDisclosure } from "@/state/ui";
import { Edit } from "@honeyicons/react";

const KIND_LABEL = {
  create: "created",
  edit: "edited",
  delete: "deleted",
} as const;

function DiffCount({ diff }: { diff: string }) {
  const { added, removed } = diffStats(diff);
  if (added === 0 && removed === 0) {
    return null;
  }
  return (
    <span className="ml-1 inline-flex shrink-0 gap-2 font-mono text-xs tabular-nums">
      {added > 0 ? <span className="text-added">+{added}</span> : null}
      {removed > 0 ? <span className="text-removed">−{removed}</span> : null}
    </span>
  );
}

export function FileChangeRow({ item }: { item: ItemSnapshot }) {
  const fileChange = item.fileChange;
  const diff = fileChange?.diff;
  // `DisclosureRow` keeps its content mounted while closed, and a settled turn
  // folds all of its work rows into one collapsed group — so every patch in
  // that turn used to reach the two-worker highlight pool the moment the single
  // virtualized group row scrolled into the draw distance, expanded or not.
  // Read the same disclosure state the row uses and hold the diff back until it
  // is open, which is what the Changes pane already does for its own list.
  const [open] = useRowDisclosure(item.itemId, diff !== undefined);
  // `fileChange` is optional on the contract, so a connector can emit the item
  // with nothing but its text. Returning null there dropped the row out of the
  // transcript while the enclosing work group still counted it as a tool call
  // — every other row kind falls back to `item.text`, and so does this one.
  if (fileChange === undefined) {
    return (
      <DisclosureRow
        rowId={item.itemId}
        icon={Edit}
        label={<span className="font-mono text-xs">{fileChangeFallbackLabel(item.text)}</span>}
        status={item.status}
      />
    );
  }
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon={Edit}
      label={
        <>
          <span className="font-mono text-xs">{fileChange.path}</span>
          <span
            className={cn(
              "ml-1 shrink-0 rounded-sm px-1 type-micro",
              fileChange.kind === "create" && "bg-added-bg text-added",
              fileChange.kind === "delete" && "bg-removed-bg text-removed",
              fileChange.kind === "edit" && "bg-hover text-muted-foreground",
            )}
          >
            {KIND_LABEL[fileChange.kind]}
          </span>
        </>
      }
      status={item.status}
      meta={diff !== undefined ? <DiffCount diff={diff} /> : null}
      defaultOpen={diff !== undefined}
    >
      {diff === undefined ? (
        <p className="whitespace-pre-wrap">{item.text ?? "No diff recorded."}</p>
      ) : open ? (
        <InlineDiff patch={diff} />
      ) : (
        // Non-undefined, so the row still counts as expandable.
        <div />
      )}
    </DisclosureRow>
  );
}
