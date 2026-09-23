/**
 * The Archived threads page: every archived thread, grouped by project, with
 * Unarchive and Delete.
 *
 * Archiving takes a thread out of the sidebar tree, so this is where archived
 * threads live — and the way back. Unarchive puts the thread back in the
 * sidebar; Delete is durable and asks first. Both go through the same
 * dispatch as the sidebar row menu (`thread-actions`), so a refusal reads the
 * same in either place.
 *
 * The data is the sidebar's own thread list subscription, which carries
 * archived threads with status `archived`; grouping is `./archived-groups`.
 */

import { Link } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@OpenAde/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@OpenAde/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  THREAD_DELETE_DESCRIPTION,
  threadCommandBase,
  useThreadCommand,
} from "@/components/sidebar/thread-actions";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";
import { Archive, ArchiveUp, Trash } from "@honeyicons/react";

import { archivedGroups } from "./archived-groups";

const ARCHIVED_AT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function ArchivedRow({
  thread,
  disabled,
  onUnarchive,
  onDelete,
}: {
  readonly thread: ThreadSummary;
  readonly disabled: boolean;
  readonly onUnarchive: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/t/$threadId"
          params={{ threadId: thread.threadId }}
          className="truncate text-sm font-medium hover:underline"
        >
          {thread.title}
        </Link>
        {thread.preview === undefined || thread.preview === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{thread.preview}</span>
        )}
      </div>
      <time
        dateTime={thread.updatedAt}
        title="Archived"
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {ARCHIVED_AT.format(new Date(thread.updatedAt))}
      </time>
      <Button variant="outline" size="sm" disabled={disabled} onClick={onUnarchive}>
        <ArchiveUp />
        Unarchive
      </Button>
      <Button
        variant="destructive"
        size="sm"
        disabled={disabled}
        aria-label={`Delete ${thread.title}`}
        onClick={onDelete}
      >
        <Trash />
        Delete
      </Button>
    </li>
  );
}

export function ArchivedThreadsPanel() {
  const threads = useThreadList();
  const projects = useProjects();
  const connection = useConnectionState();
  const send = useThreadCommand();
  const [deleting, setDeleting] = React.useState<ThreadSummary | null>(null);

  const groups = React.useMemo(() => archivedGroups(threads, projects), [threads, projects]);
  const disabled = connection.status !== "connected";

  const unarchive = (thread: ThreadSummary) =>
    void send(
      { type: "thread.unarchive", ...threadCommandBase(thread.threadId) },
      "Thread was not unarchived",
      "Unarchived",
    );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Archived threads</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Archived threads are kept, not deleted. Unarchive one to put it back in the sidebar.
        </p>
      </div>

      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive />
            </EmptyMedia>
            <EmptyTitle>No archived threads</EmptyTitle>
            <EmptyDescription>
              Archive a thread from its menu in the sidebar and it shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((group) => (
          <Card key={group.projectId ?? "other"} size="sm">
            <CardHeader>
              <CardTitle>{group.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y divide-border">
                {group.threads.map((thread) => (
                  <ArchivedRow
                    key={thread.threadId}
                    thread={thread}
                    disabled={disabled}
                    onUnarchive={() => unarchive(thread)}
                    onDelete={() => setDeleting(thread)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}

      {/* One dialog for the page, not one per row: it names whichever thread
          is pending deletion. Deleting has no undo, so it asks first. */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
          }
        }}
        title={deleting === null ? "Delete thread?" : `Delete ${deleting.title}?`}
        description={THREAD_DELETE_DESCRIPTION}
        confirmLabel="Delete thread"
        onConfirm={() => {
          if (deleting === null) {
            return;
          }
          const { threadId } = deleting;
          setDeleting(null);
          void send(
            { type: "thread.delete", ...threadCommandBase(threadId) },
            "Thread was not deleted",
            "Deleted",
          );
        }}
      />
    </div>
  );
}
