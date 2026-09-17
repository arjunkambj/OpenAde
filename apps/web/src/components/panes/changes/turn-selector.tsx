/**
 * The changes pane's comparison picker: two selects that cover the three
 * comparisons the spec asks for.
 *
 * - base `HEAD` + target `working tree` — what the pane opens on.
 * - base `checkpoint` + target `working tree` — one turn's changes, still live.
 * - base `checkpoint` + target `checkpoint` — turn to turn.
 *
 * The values are the git refs themselves, so the selection is exactly the
 * `git.diff` payload; `HEAD` and `working tree` are the two sentinels that mean
 * "omit this end" (`from` defaults to HEAD server-side, an omitted `to` means
 * the working tree).
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";

import { HEAD_VALUE, WORKTREE_VALUE, checkpointLabel } from "./selection";

function RefSelect({
  label,
  value,
  sentinel,
  sentinelLabel,
  checkpoints,
  onChange,
}: {
  label: string;
  value: string;
  sentinel: string;
  sentinelLabel: string;
  checkpoints: ReadonlyArray<CheckpointSummary>;
  onChange: (next: string) => void;
}) {
  // The select's values are refs, so the trigger has to be told what to print —
  // left alone it renders the raw `__head__` / `refs/openade/...` string.
  const labelOf = (selected: string): string => {
    const index = checkpoints.findIndex((checkpoint) => checkpoint.ref === selected);
    const checkpoint = checkpoints[index];
    return checkpoint === undefined ? sentinelLabel : checkpointLabel(checkpoint, index);
  };

  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="type-micro text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={(next) => onChange(next as string)}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue placeholder={sentinelLabel}>
            {(selected: unknown) => labelOf(String(selected))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={sentinel}>{sentinelLabel}</SelectItem>
          {checkpoints.map((checkpoint, index) => (
            <SelectItem key={checkpoint.checkpointId} value={checkpoint.ref}>
              {checkpointLabel(checkpoint, index)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function TurnSelector({
  checkpoints,
  base,
  target,
  onBaseChange,
  onTargetChange,
}: {
  checkpoints: ReadonlyArray<CheckpointSummary>;
  base: string;
  target: string;
  onBaseChange: (next: string) => void;
  onTargetChange: (next: string) => void;
}) {
  return (
    <div className="flex items-end gap-2">
      <RefSelect
        label="From"
        value={base}
        sentinel={HEAD_VALUE}
        sentinelLabel="HEAD"
        checkpoints={checkpoints}
        onChange={onBaseChange}
      />
      <RefSelect
        label="To"
        value={target}
        sentinel={WORKTREE_VALUE}
        sentinelLabel="Working tree"
        checkpoints={checkpoints}
        onChange={onTargetChange}
      />
    </div>
  );
}
