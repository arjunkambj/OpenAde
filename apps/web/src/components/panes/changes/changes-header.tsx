/**
 * The Changes pane's status lines: what "Branch" compares with, shown in the
 * toolbar beside the scope, and the tail of a restore, the one line that ever
 * appears under it.
 */

import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import { AlertTriangle, Spinner } from "@honeyicons/react";

/**
 * What "Branch" compares with, beside the menu: `vs <base>`. The branch itself
 * is the thread header's, so it is not repeated. On the base branch itself the
 * fork point is `HEAD` (or behind it), so the diff is only the uncommitted
 * work — the tooltip says so, or an empty list would read as "the branch has
 * no commits".
 */
export function BaseLine({ base, current }: { base: string; current: string | null }) {
  const onBase = current === base;
  return (
    <span
      className="min-w-0 truncate type-micro text-muted-foreground"
      title={
        onBase
          ? `You are on ${base} itself, so only uncommitted work shows.`
          : `Compared with ${base} from where ${current ?? "this branch"} forked, uncommitted work included.`
      }
    >
      vs <span className="font-mono">{base}</span>
    </span>
  );
}

/**
 * The tail of a restore: running, or the reason git refused the last one. The
 * failure line stays up until another restore is ordered — it is the only
 * place that message is ever shown, and it arrives long after the dialog that
 * started the restore has closed.
 */
export function RestoreProgress({
  restoring,
  failure,
}: {
  restoring: CheckpointSummary | null;
  failure: { readonly message: string } | null;
}) {
  if (restoring !== null) {
    return (
      <div role="status" className="flex items-center gap-2 type-micro text-muted-foreground">
        <Spinner variant="bold" className="size-3.5" />
        <span className="min-w-0 truncate">Restoring the worktree…</span>
      </div>
    );
  }
  if (failure !== null) {
    return (
      <div role="alert" className="flex items-start gap-2 type-micro text-removed">
        <AlertTriangle variant="bold" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">Restore failed: {failure.message}</span>
      </div>
    );
  }
  return null;
}
