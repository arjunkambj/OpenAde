/**
 * The editable "allow always" pattern field. The preview line runs the same
 * matcher the server enforces — `@OpenAde/shared/permissionPattern` — against
 * the live request, so what the card claims is exactly what will persist.
 */

import { Input } from "@OpenAde/ui/components/input";
import { cn } from "@OpenAde/ui/lib/utils";
import {
  parsePattern,
  patternMatches,
  type PatternSubject,
} from "@OpenAde/shared/permissionPattern";

import { AlertTriangle, Close } from "@honeyicons/react";

export function PatternEditor({
  value,
  onChange,
  subject,
  autoFocus = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The pending approval the pattern would be persisted for. */
  readonly subject: PatternSubject;
  readonly autoFocus?: boolean;
}) {
  const parsed = parsePattern(value);
  const matches = patternMatches(value, subject);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="font-mono">
        <Input
          value={value}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Shell(npm run *)"
          aria-label="Permission pattern"
        />
      </div>
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs",
          parsed === null
            ? "text-destructive"
            : matches
              ? "text-muted-foreground"
              : "text-permission",
        )}
        role="status"
      >
        {parsed === null ? (
          <>
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>
              Not a valid pattern — use Shell(cmd *), Edit(/path/**), Read(...), WebFetch(...) or
              mcp__server__tool.
            </span>
          </>
        ) : matches ? (
          <>
            <Close className="size-3.5 shrink-0" />
            <span>Matches this request.</span>
          </>
        ) : (
          <>
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>Parses, but would not have matched this request.</span>
          </>
        )}
      </div>
    </div>
  );
}
