/**
 * The New task page's hand-over: once its first message has created a local
 * thread — one working in the project's folder — the project's terminals
 * become the thread's (`terminal.adopt`), so a shell started on the page, a
 * dev server say, is right there in the thread's drawer.
 *
 * The server moves the terminals; this moves what the client keeps per owner
 * after them: the drawer's tabs and the one in front (`handOverDrawerState`),
 * and whether the drawer is open (`handOverDrawerOpen`). The tabs move before
 * the drawer closes on the project, so the page's drawer, on its way out,
 * never sits open with no tabs — the state in which it would start a fresh
 * shell. Only the page calls this, and only for a local thread: a worktree
 * thread runs elsewhere, so the shells stay the project's.
 *
 * A refused hand-over (an older server, a thread that is gone) leaves every
 * shell with the project, where the New task header and the sidebar count it.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import { terminalOwnerKey } from "@OpenAde/contracts/terminal";
import * as React from "react";

import { useDrawerStateHandOver } from "@/components/terminal/drawer-state";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { useDrawerOpenHandOver } from "@/state/terminal-ui";

export const useTerminalHandOver = () => {
  const adopt = useAtomSet(useTerminalAtoms().adoptTerminals, { mode: "promiseExit" });
  const moveTabs = useDrawerStateHandOver();
  const moveOpen = useDrawerOpenHandOver();
  return React.useCallback(
    async (projectId: ProjectId, threadId: ThreadId): Promise<void> => {
      const exit = await adopt({ projectId, threadId });
      if (exit._tag !== "Success" || exit.value.length === 0) {
        return;
      }
      const from = terminalOwnerKey({ projectId });
      const to = terminalOwnerKey({ threadId });
      moveTabs(from, to);
      moveOpen(from, to);
    },
    [adopt, moveTabs, moveOpen],
  );
};
