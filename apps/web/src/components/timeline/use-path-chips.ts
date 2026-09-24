/**
 * Which of a row's candidate paths are files in the thread's workspace: one
 * `files.stat` batch per message or tool row, through `fileStatAtom`.
 *
 * The answer arrives after the row paints, so until it does nothing is a chip
 * and the text renders plainly — a path the workspace does not have never
 * flashes as a chip first. While a message streams its candidate set grows,
 * and each new set is a new question; the previous answer is held meanwhile,
 * so a chip already shown does not drop back to plain text for a frame.
 *
 * The question is asked under the workspace's revision: when a turn or a
 * restore settles, every row on screen asks again, so a file created during
 * the turn becomes a chip and a removed one stops being one. The previous
 * answer is held meanwhile, as above.
 *
 * It takes the thread rather than reading it from context: outside a timeline
 * there is no workspace to ask and no runtime to ask it through, so
 * `PathChipsProvider` (`path-chips.tsx`) only calls this inside one.
 */

import { useAtomValue } from "@effect/atom-react";
import type { FileQuery } from "@OpenAde/client-runtime/fileAtoms";
import type { FileStat } from "@OpenAde/contracts/rpc";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import { useFileAtoms } from "@/components/panes/files/file-atoms";
import { type ConfirmedFile, confirmedFiles } from "@/components/timeline/path-links";
import type { TimelineThread } from "@/components/timeline/thread-context";

type StatResult = AsyncResult.AsyncResult<FileQuery<ReadonlyArray<FileStat>>, unknown>;

const nothingAsked: StatResult = AsyncResult.success({ _tag: "ok", value: [] });
const noQuestion: Atom.Atom<StatResult> = Atom.make((): StatResult => nothingAsked);

/** The confirmed files among `candidates`, keyed by the candidate string. */
export const usePathChips = (
  thread: TimelineThread,
  candidates: ReadonlyArray<string>,
): ReadonlyMap<string, ConfirmedFile> => {
  const atoms = useFileAtoms();
  const atom: Atom.Atom<StatResult> =
    candidates.length === 0
      ? noQuestion
      : atoms.fileStatAtom({
          projectId: thread.projectId,
          threadId: thread.threadId,
          paths: candidates,
          revision: thread.workspaceRevision,
        });
  const result = useAtomValue(atom);
  const answer =
    AsyncResult.isSuccess(result) && result.value._tag === "ok" ? result.value.value : null;

  const held = React.useRef<{ threadId: string; stats: ReadonlyArray<FileStat> }>({
    threadId: thread.threadId,
    stats: [],
  });
  const { threadId } = thread;
  if (answer !== null || held.current.threadId !== threadId) {
    held.current = { threadId, stats: answer ?? [] };
  }
  const stats = held.current.stats;
  return React.useMemo(() => confirmedFiles(stats), [stats]);
};
