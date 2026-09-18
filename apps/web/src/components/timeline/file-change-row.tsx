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
  // `fileChange` is optional on the contract, so a connector can emit the item
  // with nothing but its text. Returning null there dropped the row out of the
  // transcript while the enclosing work group still counted it as a tool call
  // — every other row kind falls back to `item.text`, and so does this one.
  if (fileChange === undefined) {
    return (
      <DisclosureRow
        rowId={item.itemId}
        icon="hugeicons:file-edit"
        label={<span className="font-mono text-xs">{fileChangeFallbackLabel(item.text)}</span>}
        status={item.status}
      />
    );
  }
  const diff = fileChange.diff;
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon="hugeicons:file-edit"
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
      {diff !== undefined ? (
        <InlineDiff patch={diff} />
      ) : (
        <p className="whitespace-pre-wrap">{item.text ?? "No diff recorded."}</p>
      )}
    </DisclosureRow>
  );
}
