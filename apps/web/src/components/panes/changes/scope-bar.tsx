/**
 * What the Changes pane compares, and how it lays a patch out.
 *
 * - **This turn** — the turn selector and the restore controls: a turn's
 *   checkpoint against the working tree, or turn to turn.
 * - **Branch vs base** — everything the branch has done since it forked from
 *   its base, commits and uncommitted work together.
 * - **Uncommitted** — the working tree against `HEAD`.
 *
 * The Split toggle puts old and new side by side. Both choices are remembered
 * (`useChangesScope`, `useDiffStyle`) for every thread.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import { Toggle } from "@OpenAde/ui/components/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";

import type { ChangesScope, DiffStyle } from "@/state/ui";

const SCOPES: ReadonlyArray<{ readonly value: ChangesScope; readonly label: string }> = [
  { value: "turn", label: "This turn" },
  { value: "branch", label: "Branch vs base" },
  { value: "uncommitted", label: "Uncommitted" },
];

const isScope = (value: unknown): value is ChangesScope =>
  SCOPES.some((scope) => scope.value === value);

export function ScopeBar({
  scope,
  onScopeChange,
  diffStyle,
  onDiffStyleChange,
}: {
  scope: ChangesScope;
  onScopeChange: (next: ChangesScope) => void;
  diffStyle: DiffStyle;
  onDiffStyleChange: (next: DiffStyle) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Select
          value={scope}
          onValueChange={(next) => {
            if (isScope(next)) {
              onScopeChange(next);
            }
          }}
          items={SCOPES}
        >
          <SelectTrigger className="w-full" aria-label="Compare">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              pressed={diffStyle === "split"}
              onPressedChange={(pressed) => onDiffStyleChange(pressed ? "split" : "unified")}
            />
          }
        >
          Split
        </TooltipTrigger>
        <TooltipContent>Show old and new side by side</TooltipContent>
      </Tooltip>
    </div>
  );
}
