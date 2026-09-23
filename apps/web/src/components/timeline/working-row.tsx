/**
 * The trailing row while a turn is open: a spinner, "Working…" and how long
 * the turn has run. The start time rides on the row itself (see `buildTimeline`)
 * so the row stays a function of its data; only the ticking clock is local.
 */

import type { TimelineWorkingRow } from "@/components/timeline/fold";
import { formatElapsed } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Spinner } from "@honeyicons/react";

export function WorkingRow({ row }: { row: TimelineWorkingRow }) {
  return (
    <div className="flex min-h-6 items-center gap-2 py-0.5 type-body text-muted-foreground">
      <Spinner className="size-3.5" />
      Working…
      {row.startedAt === undefined ? null : <Elapsed startedAt={row.startedAt} />}
    </div>
  );
}

/** Split out so only the clock re-renders each second, not the whole row. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1_000);
  return (
    <span className="text-muted-foreground tabular-nums">{formatElapsed(now - startedAt)}</span>
  );
}
