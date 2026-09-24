/**
 * `turn-summary` — the card after a settled turn's answer, when the turn
 * changed files: "Changed 3 files +20 −4", then one line per path with its
 * counts. It lists paths only and never renders a diff, so a long history of
 * turns costs no highlighting work; the diffs live in the turn's work groups
 * and in the Changes pane, which the card links to: "Open in Changes" shows
 * this very turn — the checkpoint it left, or the latest turn when it left
 * none — and each path opens that file in it, scrolled into view
 * (`changesLink`).
 *
 * A path is labelled as the file-change rows above label it: relative to the
 * workspace once the workspace confirms the file (`PathChipsContext`), as the
 * agent recorded it — often absolute — until then. The card resolves its
 * paths that way but draws no chips: each line is already a Changes link.
 *
 * The card starts open, like a plan card, and folds with collapse-all. It
 * lists five files, then "Show N more", whose state is in the row disclosure
 * map (`turn-summary-files:<row id>`) so it holds when the row is recycled.
 *
 * Under the files: "Undo", which restores the workspace to the checkpoint
 * before this turn through the timeline's restore dialog — left out when
 * there is none (the thread's first turn, a workspace without git), disabled
 * with the reason while no restore can start — and "Open in Changes".
 */

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@OpenAde/ui/components/collapsible";
import type { TurnId } from "@OpenAde/contracts/ids";
import { Button } from "@OpenAde/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { changesLink } from "@/components/panes/changes/deep-link";
import { FileChangeKindBadge } from "@/components/timeline/file-change-badge";
import { PathChipsContext, PathChipsProvider } from "@/components/timeline/path-chips";
import type { TimelineTurnSummaryRow, TurnSummaryFile } from "@/components/timeline/fold";
import { RestoreBeforeTurn } from "@/components/timeline/restore-before-turn";
import { useTimelineThreadId } from "@/components/timeline/thread-context";
import { turnSummaryLead } from "@/lib/format";
import { useRowDisclosure } from "@/state/ui";
import { ChevronDown, ChevronRight, ChevronUp, GitDiff, Undo } from "@honeyicons/react";

/** Files the card lists before "Show N more". */
const SUMMARY_FILE_LIMIT = 5;

type OpenInChanges = (file?: string) => void;

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return null;
  }
  return (
    <span className="ml-1.5 inline-flex gap-1.5 font-mono text-xs font-normal tabular-nums">
      {added > 0 ? <span className="text-added">+{added}</span> : null}
      {removed > 0 ? <span className="text-removed">−{removed}</span> : null}
    </span>
  );
}

/**
 * Opens the thread's Changes pane on this turn, and on one of its files when
 * given; `null` where there is no thread to open it in (fixtures).
 */
function useOpenInChanges(checkpointRef: string | undefined): OpenInChanges | null {
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

export function SummaryFile({
  file,
  onOpen,
}: {
  file: TurnSummaryFile;
  onOpen: OpenInChanges | null;
}) {
  const label = React.useContext(PathChipsContext).get(file.path)?.relativePath ?? file.path;
  const line = (
    <>
      <span className="min-w-0 truncate font-mono text-xs text-foreground">{label}</span>
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
          // The stock button never shrinks; this one must, so a long path
          // truncates inside the row instead of running past it.
          className="max-w-full min-w-0 shrink"
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
    <Button variant="ghost" size="xs" onClick={onOpen}>
      <GitDiff variant="bold" data-icon="inline-start" />
      Open in Changes
    </Button>
  );
}

function UndoTurn({ turnId }: { turnId: TurnId | undefined }) {
  return (
    <RestoreBeforeTurn
      turnId={turnId}
      tooltip="Restore the workspace to before this turn"
      title="Undo this turn?"
      description="The workspace goes back to how it was before this turn ran: every tracked file returns to that checkpoint and files created since are removed, so this turn's changes and those of any turn after it are undone. Uncommitted work that is not in a checkpoint is lost. The conversation stays as it is."
      skippedNote="The turn before this one has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too."
      renderButton={(props) => (
        <Button variant="ghost" size="xs" {...props}>
          <Undo variant="bold" data-icon="inline-start" />
          Undo
        </Button>
      )}
    />
  );
}

function FileList({
  summary,
  onOpen,
}: {
  summary: TimelineTurnSummaryRow;
  onOpen: OpenInChanges | null;
}) {
  const [all, setAll] = useRowDisclosure(`turn-summary-files:${summary.id}`);
  const hiddenCount = summary.files.length - SUMMARY_FILE_LIMIT;
  const files = all ? summary.files : summary.files.slice(0, SUMMARY_FILE_LIMIT);
  const listId = `${summary.id}:files`;
  return (
    <>
      <PathChipsProvider candidates={summary.files.map((file) => file.path)}>
        <ul id={listId} className="flex flex-col">
          {files.map((file) => (
            <SummaryFile key={file.path} file={file} onOpen={onOpen} />
          ))}
        </ul>
      </PathChipsProvider>
      {hiddenCount > 0 ? (
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll(!all)}
        >
          {all ? (
            <ChevronUp variant="bold" data-icon="inline-start" />
          ) : (
            <ChevronDown variant="bold" data-icon="inline-start" />
          )}
          {all ? "Show less" : `Show ${hiddenCount} more`}
        </Button>
      ) : null}
    </>
  );
}

export function TurnSummaryRow({ summary }: { summary: TimelineTurnSummaryRow }) {
  const [open, setOpen] = useRowDisclosure(summary.id, true);
  const openInChanges = useOpenInChanges(summary.checkpointRef);
  return (
    <Collapsible open={open} onOpenChange={setOpen} variant="card">
      <CollapsibleTrigger variant="card">
        <GitDiff variant="bold" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {turnSummaryLead(summary)}
          <DiffCounts added={summary.added} removed={summary.removed} />
        </span>
        <ChevronRight
          variant="bold"
          className="size-3.5 shrink-0 text-muted-foreground transition-reveal duration-150 ease-out group-data-open/row:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted variant="card">
        <div className="flex flex-col gap-1">
          <FileList summary={summary} onOpen={openInChanges} />
          <div className="flex flex-wrap items-center gap-1">
            <UndoTurn key={summary.id} turnId={summary.turnId} />
            {openInChanges === null ? null : <OpenChanges onOpen={() => openInChanges()} />}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
