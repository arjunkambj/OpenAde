/**
 * The thread-switching and history keys, which work from any route — so this
 * is mounted once at the root, inside `KeybindingsProvider`, beside the
 * palette's own route-independent commands.
 *
 * - `nav.back` / `nav.forward` walk the router's history, as the chrome's
 *   back and forward buttons do. Back does nothing at the start of the stack.
 * - `thread.jump.1`…`9` open the Nth thread in sidebar order and
 *   `thread.previous` / `thread.next` step through it with wrap; with no
 *   thread open they start from the last or the first. The order is the
 *   tree's own (`@/components/sidebar/thread-order`), folded projects and all,
 *   so the Nth thread is the Nth row on screen.
 * - `thread.newInProject` starts a thread in the open thread's project, else
 *   the last project used, else the first, through the one create flow.
 *
 * A command is claimed only while it has something to act on — no threads, no
 * stepping; no project, no new thread — so the palette never offers a row
 * that does nothing. The numbered jumps stay claimed and a number past the end
 * does nothing; the palette does not list them.
 */

import { useCanGoBack, useMatchRoute, useNavigate, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { THREAD_JUMP_COMMANDS } from "@OpenAde/contracts/keybindings";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadSummary } from "@OpenAde/contracts/orchestration";

import {
  neighbourThread,
  nthThread,
  projectForNewThread,
  sidebarThreadOrder,
} from "@/components/sidebar/thread-order";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useProjects, useThreadList } from "@/state/hooks";
import { useCollapsedProjects, useLastProject } from "@/state/ui";

type OpenThread = (threadId: ThreadId) => void;

function HistoryShortcuts() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  useKeybindingCommand("nav.back", () => {
    if (canGoBack) {
      router.history.back();
    }
  });
  useKeybindingCommand("nav.forward", () => router.history.forward());
  return null;
}

function ThreadJumpShortcut({
  command,
  n,
  order,
  open,
}: {
  readonly command: string;
  readonly n: number;
  readonly order: ReadonlyArray<ThreadSummary>;
  readonly open: OpenThread;
}) {
  useKeybindingCommand(command, () => {
    const target = nthThread(order, n);
    if (target !== undefined) {
      open(target.threadId);
    }
  });
  return null;
}

function ThreadStepShortcuts({
  order,
  openThreadId,
  open,
}: {
  readonly order: ReadonlyArray<ThreadSummary>;
  readonly openThreadId: string | null;
  readonly open: OpenThread;
}) {
  const step = (by: 1 | -1) => {
    const target = neighbourThread(order, openThreadId, by);
    if (target !== undefined && target.threadId !== openThreadId) {
      open(target.threadId);
    }
  };
  useKeybindingCommand("thread.previous", () => step(-1));
  useKeybindingCommand("thread.next", () => step(1));
  return null;
}

function NewInProjectShortcut({ projectId }: { readonly projectId: ProjectId }) {
  const { create, pending } = useCreateThread();
  useKeybindingCommand("thread.newInProject", () => {
    if (!pending) {
      void create(projectId);
    }
  });
  return null;
}

export function AppShortcuts() {
  const projects = useProjects();
  const threads = useThreadList();
  const collapsed = useCollapsedProjects();
  const [lastProject] = useLastProject();
  const navigate = useNavigate();
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;

  const order = React.useMemo(
    () => sidebarThreadOrder(projects, threads, collapsed, openThreadId),
    [projects, threads, collapsed, openThreadId],
  );
  const openThreadProject = threads.find((thread) => thread.threadId === openThreadId)?.projectId;
  const newThreadProject = projectForNewThread(projects, openThreadProject, lastProject);

  const open = React.useCallback<OpenThread>(
    (threadId) => void navigate({ to: "/t/$threadId", params: { threadId } }),
    [navigate],
  );

  return (
    <>
      <HistoryShortcuts />
      {THREAD_JUMP_COMMANDS.map((command, index) => (
        <ThreadJumpShortcut
          key={command}
          command={command}
          n={index + 1}
          order={order}
          open={open}
        />
      ))}
      {order.length > 0 ? (
        <ThreadStepShortcuts order={order} openThreadId={openThreadId} open={open} />
      ) : null}
      {newThreadProject === undefined ? null : (
        <NewInProjectShortcut projectId={newThreadProject.projectId} />
      )}
    </>
  );
}
