/**
 * The branch picker's popover body for a worktree thread: what the worktree
 * is, with no switching. The thread owns that worktree's branch — it was cut
 * for this thread — so the header shows where the work lands instead of
 * offering to move it.
 */

import type { ThreadWorktree } from "@OpenAde/contracts/git";

import { FolderTree } from "@honeyicons/react";

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="type-micro text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all text-foreground">{value}</dd>
    </div>
  );
}

export function WorktreeDetails({
  worktree,
  current,
}: {
  worktree: ThreadWorktree;
  /** The branch the worktree is on now, when it could be read. */
  current: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <FolderTree variant="bold" className="size-4 shrink-0" />
        This thread works in its own worktree
      </div>
      <dl className="flex flex-col gap-2">
        <Detail label="Branch" value={current ?? worktree.branch} />
        {worktree.baseBranch === undefined ? null : (
          <Detail label="Cut from" value={worktree.baseBranch} />
        )}
        <Detail label="Path" value={worktree.path} />
      </dl>
      <p className="type-micro text-muted-foreground">
        The branch belongs to this thread, so it is not switched here. Local threads of the project
        are unaffected by its changes.
      </p>
    </div>
  );
}
