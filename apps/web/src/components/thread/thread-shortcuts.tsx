/**
 * The lifecycle keys for the open thread: `thread.rename`, `thread.archive`
 * and `thread.delete`. Mounted by `ThreadView` once its snapshot is in, so they
 * answer only while a thread is open (their `when` clause says `threadOpen`,
 * which the view publishes).
 *
 * They do what the sidebar row's overflow menu does, through the same pieces:
 * the same rename form, the same delete confirmation — with its offer to remove
 * a worktree thread's worktree too — and the same dispatch and toasts from
 * `@/components/sidebar/thread-actions` and `use-delete-thread`. Archive
 * unarchives a thread that is already archived, as the menu offers. Delete
 * only ever opens the confirmation — nothing is deleted from a key alone.
 *
 * `DockShortcuts` holds the right dock's keys for the same view:
 * `dock.toggle`, `dock.changes`, `dock.files` and `browserPane.toggle`, with
 * the targets from `@/components/dock/dock-toggle`: the toggle opens on the
 * thread's last tab this session, else the launcher, and each tab's key goes
 * straight to its tab — from the launcher too — or closes the dock when it is
 * already there. Opening Files from its key also asks the Files pane to focus
 * its search.
 */

import * as React from "react";

import type { ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadStatus } from "@OpenAde/contracts/orchestration";

import { dockTabTarget, type DockPane, type DockTab } from "@/components/dock/dock-toggle";
import { DeleteThreadDialog } from "@/components/sidebar/delete-thread-dialog";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { RenameThreadDialog } from "@/components/sidebar/thread-menu";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useThreadList } from "@/state/hooks";

type OpenDialog = "rename" | "delete" | null;

export function ThreadShortcuts({
  threadId,
  title,
  status,
}: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: ThreadStatus;
}) {
  const send = useThreadCommand();
  const remove = useDeleteThread();
  // The list row carries the worktree the delete dialog offers to remove.
  const summary = useThreadList().find((thread) => thread.threadId === threadId) ?? null;
  const [dialog, setDialog] = React.useState<OpenDialog>(null);
  const base = () => threadCommandBase(threadId);
  const gone = status === "deleted";

  useKeybindingCommand("thread.rename", () => {
    if (!gone) {
      setDialog("rename");
    }
  });
  useKeybindingCommand("thread.archive", () => {
    if (gone) {
      return;
    }
    void (status === "archived"
      ? send({ ...base(), type: "thread.unarchive" }, "Thread was not unarchived", "Unarchived")
      : send({ ...base(), type: "thread.archive" }, "Thread was not archived", "Archived"));
  });
  useKeybindingCommand("thread.delete", () => {
    if (!gone && summary !== null) {
      setDialog("delete");
    }
  });

  return (
    <>
      <RenameThreadDialog
        title={title}
        open={dialog === "rename"}
        onOpenChange={(next) => setDialog(next ? "rename" : null)}
        onSubmit={(next) =>
          void send({ ...base(), type: "thread.rename", title: next }, "Thread was not renamed")
        }
      />
      <DeleteThreadDialog
        thread={summary}
        open={dialog === "delete"}
        onOpenChange={(next) => setDialog(next ? "delete" : null)}
        onConfirm={(target, removeWorktree) => void remove(target, removeWorktree)}
      />
    </>
  );
}

export function DockShortcuts({
  dockTab,
  onToggle,
  onShow,
}: {
  readonly dockTab: DockPane | undefined;
  /** Open on the last tab (else the launcher), or close — the header button's own action. */
  readonly onToggle: () => void;
  /** Move the dock to a tab (null closes it); `focus` asks that tab to take focus. */
  readonly onShow: (tab: DockTab | null, focus?: boolean) => void;
}) {
  useKeybindingCommand("dock.toggle", onToggle);
  useKeybindingCommand("dock.changes", () => onShow(dockTabTarget(dockTab, "changes")));
  useKeybindingCommand("dock.files", () => {
    const target = dockTabTarget(dockTab, "files");
    onShow(target, target === "files");
  });
  useKeybindingCommand("browserPane.toggle", () => onShow(dockTabTarget(dockTab, "browser")));
  return null;
}
