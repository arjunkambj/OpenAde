/**
 * The pending-approval card. Renders the request subject, offers the four
 * decisions from `ApprovalDecision`, and dispatches `thread.approval.respond`
 * through `dispatchAtom`. The card is unmounted by the doc when the
 * `thread.approval.resolved` event lands — a rejected receipt is shown inline
 * instead, so nothing here pretends a decision stuck before the server says so.
 *
 * Keys while the card is up, by default: `1` allow once, `2` allow for
 * session, `3` always allow (persists the pattern), `D`/`Escape` deny. They
 * are rows in the keybinding table (`approval.*`) whose `when` clause —
 * `approvalPending && !inputFocus && !dialogOpen` — is the whole claim rule:
 * a field, a dialog or the composer's trigger menu keeps its keys, and the
 * card's `Escape` never competes with `thread.interrupt`, whose clause
 * excludes exactly this case. The labels read the live table.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import type { ApprovalDecision } from "@OpenAde/contracts/enums";
import type { ThreadId } from "@OpenAde/contracts/ids";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { ApprovalRequest } from "@OpenAde/contracts/runtime";
import { parsePattern } from "@OpenAde/shared/permissionPattern";
import * as React from "react";

import { CardShell } from "@/components/approvals/card-shell";
import { PatternEditor } from "@/components/approvals/pattern-editor";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { CommandKbd, useKeybindingCommand } from "@/lib/shortcuts";
import { ChevronDown, ChevronUp, Lock } from "@honeyicons/react";

/** One-line summary of `request.input`, by approval kind. */
const subjectSummary = (request: ApprovalRequest): string | null => {
  const input = request.input;
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "filePath", "url", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
};

const KIND_LABEL: Readonly<Record<string, string>> = {
  command: "Command",
  file_write: "File write",
  file_read: "File read",
  mcp_tool: "MCP tool",
  web: "Web access",
  other: "Permission",
};

export function ApprovalCard({
  threadId,
  request,
}: {
  readonly threadId: ThreadId;
  readonly request: ApprovalRequest;
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [pattern, setPattern] = React.useState(request.patternSuggestion ?? request.toolName);
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<ApprovalDecision | null>(null);

  const summary = subjectSummary(request);
  const patternValid = parsePattern(pattern) !== null;

  const respond = React.useCallback(
    (decision: ApprovalDecision) => {
      const withPattern = decision === "allow-always" || decision === "allow-session";
      if (withPattern && !patternValid) {
        return;
      }
      setPending(decision);
      setError(null);
      void dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.approval.respond",
        threadId,
        requestId: request.requestId,
        decision,
        ...(withPattern ? { pattern } : {}),
      }).then(
        (receipt) => {
          setPending(null);
          setError(receiptError(receipt, "the server rejected the response"));
        },
        () => {
          setPending(null);
          setError(DISPATCH_UNREACHABLE);
        },
      );
    },
    [dispatch, pattern, patternValid, request.requestId, threadId],
  );

  // A key answers what the matching button would, and like the disabled
  // buttons it does nothing while an answer is already on its way.
  const byKey = (decision: ApprovalDecision) => () => {
    if (pending === null) {
      respond(decision);
    }
  };
  useKeybindingCommand("approval.allowOnce", byKey("allow-once"));
  useKeybindingCommand("approval.allowSession", byKey("allow-session"));
  useKeybindingCommand("approval.allowAlways", byKey("allow-always"));
  useKeybindingCommand("approval.deny", byKey("deny"));

  return (
    <CardShell
      icon={Lock}
      title={request.description.length > 0 ? request.description : "Approval requested"}
      hint={
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{request.toolName}</span>
          <span>{KIND_LABEL[request.kind] ?? request.kind}</span>
        </span>
      }
      actions={
        <>
          <Button size="sm" disabled={pending !== null} onClick={() => respond("allow-once")}>
            Allow once <CommandKbd command="approval.allowOnce" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null || !patternValid}
            onClick={() => respond("allow-session")}
          >
            Allow for session <CommandKbd command="approval.allowSession" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null || !patternValid}
            onClick={() => respond("allow-always")}
          >
            Always allow <CommandKbd command="approval.allowAlways" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="muted"
            disabled={pending !== null}
            onClick={() => respond("deny")}
          >
            Deny <CommandKbd command="approval.deny" />
          </Button>
        </>
      }
    >
      {summary === null ? null : (
        <pre className="max-h-32 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {summary}
        </pre>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <Button
          type="button"
          variant="ghost"
          tone="muted"
          size="xs"
          className="-ml-2 self-start"
          onClick={() => setEditing((open) => !open)}
          aria-expanded={editing}
        >
          {editing ? <ChevronDown variant="bold" /> : <ChevronUp variant="bold" />}
          Rule saved by “Allow for session” / “Always allow”
        </Button>
        {editing ? (
          <PatternEditor value={pattern} onChange={setPattern} subject={request} autoFocus />
        ) : (
          <code className="w-fit max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
            {pattern}
          </code>
        )}
      </div>
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </CardShell>
  );
}
