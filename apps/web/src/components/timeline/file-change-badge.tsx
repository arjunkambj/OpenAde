/**
 * The change kind beside a changed path — on a file-change row and on a turn
 * summary card's file lines. It lives apart from the file-change row so the
 * card can use it without pulling in the diff worker pool.
 */

import type { FileChangeKind } from "@OpenAde/contracts/runtime";

import { cn } from "@/lib/utils";

export const FILE_CHANGE_KIND_LABEL = {
  create: "created",
  edit: "edited",
  delete: "deleted",
} as const;

/** "created" / "edited" / "deleted", tinted by what the change did. */
export function FileChangeKindBadge({ kind }: { kind: FileChangeKind }) {
  return (
    <span
      className={cn(
        "ml-1 shrink-0 rounded-sm px-1 type-micro",
        kind === "create" && "bg-added-bg text-added",
        kind === "delete" && "bg-removed-bg text-removed",
        kind === "edit" && "bg-hover text-muted-foreground",
      )}
    >
      {FILE_CHANGE_KIND_LABEL[kind]}
    </span>
  );
}
