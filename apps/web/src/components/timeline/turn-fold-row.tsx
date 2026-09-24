/**
 * `turn-fold` — the one row a settled turn's work folds into, right under the
 * user's message: "Worked for 2m 3s · Ran 3 commands, edited 2 files, read 4
 * files", with the failures beside it. Opening it does not reveal a body: the
 * timeline rebuilds with the turn's work groups, reasoning and narration back
 * in the list below it, in order (`fold.ts`), so each stays its own
 * virtualized row.
 */

import type { TimelineTurnFoldRow } from "@/components/timeline/fold";
import { DisclosureRow, FailedCount } from "@/components/timeline/row-shell";
import { turnFoldLabel, withFailures } from "@/components/timeline/work-summary";
import { Stopwatch } from "@honeyicons/react";

export function TurnFoldRow({ row }: { row: TimelineTurnFoldRow }) {
  const label = turnFoldLabel(row.durationMs, row.sentence);
  return (
    <DisclosureRow
      rowId={row.id}
      icon={Stopwatch}
      label={<span title={withFailures(label, row.failedCount)}>{label}</span>}
      meta={<FailedCount count={row.failedCount} />}
      opensRows
    />
  );
}
