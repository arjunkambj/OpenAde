/**
 * A small count of the shells still running in a project's own folder — the
 * terminals the project owns rather than a thread — on the New task header,
 * beside its terminal toggle, and on the project's sidebar row.
 *
 * They are the ones left behind: a worktree thread started from New task
 * does not take them (it runs elsewhere), and a shell started on New task
 * again later stays with the project until the next local thread started
 * there takes them all (`./use-terminal-hand-over`), when the count drops to
 * nothing.
 *
 * It reads the project's `terminal.list` (`./running-terminals` counts it):
 * refetched on connecting, after every open, close and hand-over, and on a
 * return to the window, since a shell nobody is watching can exit without
 * the client hearing of it. Nothing shows while none is running.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ProjectId } from "@OpenAde/contracts/ids";
import { terminalOwnerKey } from "@OpenAde/contracts/terminal";
import { Badge } from "@OpenAde/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@OpenAde/ui/components/tooltip";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  runningTerminalCount,
  runningTerminalsLabel,
} from "@/components/terminal/running-terminals";
import { useTerminalAtoms } from "@/components/terminal/terminal-atoms";
import { useWindowReturn } from "@/lib/window-return";
import { Terminal } from "@honeyicons/react";

export function ProjectTerminalsBadge({ projectId }: { projectId: ProjectId }) {
  const listAtom = useTerminalAtoms().terminalListAtom(terminalOwnerKey({ projectId }));
  const list = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  useWindowReturn(refresh);

  const count = runningTerminalCount(AsyncResult.isSuccess(list) ? list.value : null);
  if (count === 0) {
    return null;
  }
  const label = runningTerminalsLabel(count);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="secondary" role="status" aria-label={label} className="shrink-0" />}
      >
        <Terminal variant="bold" data-icon="inline-start" />
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
