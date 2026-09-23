/**
 * One saved permission rule on the Permissions page: its pattern, whether it
 * allows or denies, when it was saved, and the edit and delete buttons. The
 * dialogs those buttons open belong to the page, not the row.
 */

import { Badge } from "@OpenAde/ui/components/badge";
import { Button } from "@OpenAde/ui/components/button";
import type { PermissionRule } from "@OpenAde/contracts/settings";

import { Edit, Trash } from "@honeyicons/react";

const SAVED_AT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function PermissionRuleRow({
  rule,
  disabled,
  onEdit,
  onDelete,
}: {
  readonly rule: PermissionRule;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-sm" title={rule.pattern}>
        {rule.pattern}
      </span>
      <Badge variant={rule.decision === "deny" ? "destructive" : "secondary"}>
        {rule.decision === "deny" ? "Deny" : "Allow"}
      </Badge>
      <time
        dateTime={rule.createdAt}
        title="Saved"
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {SAVED_AT.format(new Date(rule.createdAt))}
      </time>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={`Edit rule ${rule.pattern}`}
          onClick={onEdit}
        >
          <Edit />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={`Delete rule ${rule.pattern}`}
          onClick={onDelete}
        >
          <Trash />
        </Button>
      </div>
    </li>
  );
}
