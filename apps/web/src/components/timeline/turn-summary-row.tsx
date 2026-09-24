/**
 * `turn-summary` — the closing line of a settled turn that did work: "Worked
 * for 12s · 3 files +20 −4". When files changed, the row opens onto one line
 * per path with its counts; it lists paths only and never renders a diff, so a
 * long history of turns costs no highlighting work. The diffs themselves live
 * in the work group above and in the Changes pane, which the body links to:
 * "Open in Changes" shows this very turn — the checkpoint it left, or the
 * latest turn when it left none — and each path opens that file in it, scrolled
 * into view (`changesLink`).
 */

import { Button } from "@OpenAde/ui/components/button";
import { useNavigate } from "@tanstack/react-router";

import { changesLink } from "@/components/panes/changes/deep-link";
import { FileChangeKindBadge } from "@/components/timeline/file-change-row";
import type { TimelineTurnSummaryRow, TurnSummaryFile } from "@/components/timeline/fold";
import { DisclosureRow } from "@/components/timeline/row-shell";
import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { turnSummaryLabel, turnSummaryLead } from "@/lib/format";
import { GitDiff, Stopwatch } from "@honeyicons/react";

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return null;
  }
  return (
    <span className="ml-1.5 inline-flex gap-1.5 font-mono text-xs tabular-nums">
      {added > 0 ? <span className="text-added">+{added}</span> : null}
      {removed > 0 ? <span className="text-removed">−{removed}</span> : null}
    </span>
  );
}

/**
 * Opens the thread's Changes pane on this turn, and on one of its files when
 * given; `null` where there is no thread to open it in (fixtures).
 */
function useOpenInChanges(checkpointRef: string | undefined) {
  const threadId = useTimelineThreadId();
  const navigate = useNavigate();
  if (threadId === null) {
    return null;
  }
  return (file?: string) => {
    void navigate({
      to: "/t/$threadId",
      params: { threadId },
      search: { pane: "changes", ...changesLink(checkpointRef, file) },
      replace: true,
    });
  };
}

function SummaryFile({
  file,
  onOpen,
}: {
  file: TurnSummaryFile;
  onOpen: ((file: string) => void) | null;
}) {
  const line = (
    <>
      <span className="min-w-0 truncate font-mono text-xs text-foreground">{file.path}</span>
      <FileChangeKindBadge kind={file.kind} />
      <DiffCounts added={file.added} removed={file.removed} />
    </>
  );
  return (
    <li className="flex min-h-6 min-w-0 items-center gap-1">
      {onOpen === null ? (
        line
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0"
          title={`Open ${file.path} in Changes`}
          onClick={() => onOpen(file.path)}
        >
          {line}
        </Button>
      )}
    </li>
  );
}

function OpenChanges({ onOpen }: { onOpen: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="self-start" onClick={onOpen}>
      <GitDiff variant="bold" data-icon="inline-start" />
      Open in Changes
    </Button>
  );
}

export function TurnSummaryRow({ summary }: { summary: TimelineTurnSummaryRow }) {
  const open = useOpenInChanges(summary.checkpointRef);
  return (
    <DisclosureRow
      rowId={summary.id}
      icon={Stopwatch}
      label={
        <span title={turnSummaryLabel(summary)}>
          {turnSummaryLead(summary)}
          <DiffCounts added={summary.added} removed={summary.removed} />
        </span>
      }
      meta={
        summary.failedCount > 0 ? (
          <span className="ml-1 shrink-0 type-micro text-destructive">
            {summary.failedCount} failed
          </span>
        ) : null
      }
    >
      {summary.files.length > 0 ? (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col">
            {summary.files.map((file) => (
              <SummaryFile key={file.path} file={file} onOpen={open} />
            ))}
          </ul>
          {open === null ? null : <OpenChanges onOpen={() => open()} />}
        </div>
      ) : undefined}
    </DisclosureRow>
  );
}
