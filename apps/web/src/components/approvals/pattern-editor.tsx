/**
 * The editable permission pattern field. The preview line runs the same
 * matcher the server enforces — `@poseidon/shared/permissionPattern` — against
 * the live request, so what the card claims is exactly what will persist.
 *
 * The Permissions settings page edits a saved rule with it too. There is no
 * request to preview against there, so without a `subject` the status line
 * only says whether the pattern parses.
 */

import { Input } from "@poseidon/ui/components/input";
import { cn } from "@poseidon/ui/lib/utils";
import {
  parsePattern,
  patternMatches,
  type PatternSubject,
} from "@poseidon/shared/permissionPattern";

import { AlertTriangle, Check } from "@honeyicons/react";

export function PatternEditor({
  value,
  onChange,
  subject,
  autoFocus = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The pending approval the pattern would be persisted for, if any. */
  readonly subject?: PatternSubject;
  readonly autoFocus?: boolean;
}) {
  const parsed = parsePattern(value);
  // With no request to test, a pattern that parses is as good as it gets.
  const matches = subject === undefined || patternMatches(value, subject);

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
            <AlertTriangle variant="bold" className="size-3.5 shrink-0" />
            <span>
              Not a valid pattern — use Shell(cmd *), Edit(/path/**), Read(...), Fetch(...) or
              Mcp(server.tool).
            </span>
          </>
        ) : matches ? (
          <>
            <Check variant="bold" className="size-3.5 shrink-0" />
            <span>{subject === undefined ? "Valid pattern." : "Matches this request."}</span>
          </>
        ) : (
          <>
            <AlertTriangle variant="bold" className="size-3.5 shrink-0" />
            <span>Parses, but would not have matched this request.</span>
          </>
        )}
      </div>
    </div>
  );
}
