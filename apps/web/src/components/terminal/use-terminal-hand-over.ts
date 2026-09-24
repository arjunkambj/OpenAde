/**
 * The New task page's hand-over: once its first message has created a local
 * thread — one working in the project's folder — the project's terminals
 * become the thread's (`terminal.adopt`), so a shell started on the page, a
 * dev server say, is right there in the thread's drawer.
 *
 * The server moves the terminals; the client moves what it keeps per owner
 * after them — the drawer's tabs and the one in front, and an open drawer.
 * The order, and what happens when adopt fails or its reply is lost, is
 * `runHandOver` (`./terminal-hand-over`): the project's drawer closes before
 * adopt is called, so its listing coming back empty mid-move cannot make it
 * start a stray shell, and the client state follows only once the move is
 * known — from adopt's answer, or else from the thread's own listing.
 *
 * Only the page calls this, and only for a local thread: a worktree thread
 * runs elsewhere, so the shells stay the project's, where the New task
 * header and the sidebar count them.
 */

import { RegistryContext, useAtomSet } from "@effect/atom-react";
import type { ProjectId, TerminalId, ThreadId } from "@poseidon/contracts/ids";
import { terminalOwnerKey } from "@poseidon/contracts/terminal";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { drawerStatesAtom, useDrawerStateHandOver } from "@/components/terminal/drawer-state";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { runHandOver, type HandOverOutcome } from "@/components/terminal/terminal-hand-over";
import { openByThreadAtom, useSetDrawerOpen } from "@/state/terminal-ui";

export const useTerminalHandOver = () => {
  const registry = React.useContext(RegistryContext);
  const atoms = useTerminalAtoms();
  const adopt = useAtomSet(atoms.adoptTerminals, { mode: "promiseExit" });
  const list = useAtomSet(atoms.listTerminals, { mode: "promiseExit" });
  const moveTabs = useDrawerStateHandOver();
  const setDrawerOpen = useSetDrawerOpen();

  return React.useCallback(
    (projectId: ProjectId, threadId: ThreadId): Promise<HandOverOutcome> => {
      const from = terminalOwnerKey({ projectId });
      const to = terminalOwnerKey({ threadId });
      const idsOf = (terminals: ReadonlyArray<{ readonly terminalId: TerminalId }>) =>
        terminals.map((terminal) => terminal.terminalId);
      return runHandOver({
        // Read at the moment of the call, not from a render's closure.
        before: () => {
          const listed = registry.get(atoms.terminalListAtom(from));
          const tabs = registry.get(drawerStatesAtom)[from]?.tabs ?? [];
          const ids = new Set([
            ...idsOf(tabs),
            ...(AsyncResult.isSuccess(listed) && listed.value._tag === "ok"
              ? idsOf(listed.value.terminals)
              : []),
          ]);
          return { open: registry.get(openByThreadAtom)[from] === true, ids: [...ids] };
        },
        closeProjectDrawer: () => setDrawerOpen(from, false),
        adopt: async () => {
          const exit = await adopt({ projectId, threadId });
          return Exit.isSuccess(exit) ? idsOf(exit.value) : null;
        },
        listThread: async () => {
          const exit = await list(to);
          return Exit.isSuccess(exit) ? idsOf(exit.value) : null;
        },
        moveState: (open) => {
          moveTabs(from, to);
          if (open) {
            setDrawerOpen(to, true);
          }
        },
        reopenProjectDrawer: () => setDrawerOpen(from, true),
      });
    },
    [registry, atoms, adopt, list, moveTabs, setDrawerOpen],
  );
};
