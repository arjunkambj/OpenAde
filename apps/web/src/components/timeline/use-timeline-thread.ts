/**
 * The timeline's context value (`thread-context.tsx`), derived from the
 * snapshot and kept stable while a turn streams.
 *
 * - The checkpoints are the fold's, intersected with `checkpoints.list`
 *   (`availableCheckpoints`). The list is read per revision — the number of
 *   checkpoints the fold holds — so a new checkpoint asks again and a list
 *   read before it can never hide it; until the answer comes, or when it
 *   fails, the fold stands alone.
 * - A restore settling — restored or failed — rereads every git read of the
 *   project, the checkpoint list among them: the worktree moved, and a
 *   restore that failed on a pruned ref has just shown the list is stale.
 *   The Changes pane follows along the same way it follows its own restores.
 * - The turn order is recomputed on every item change but only replaced when
 *   a turn is added, so a streamed delta does not rerender every row.
 * - The connection is the client runtime's in context, so the fixture page
 *   reads its scripted one.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { TurnId } from "@OpenAde/contracts/ids";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { useGitAtoms } from "@/components/panes/changes/git-atoms";
import type { TimelineThread } from "@/components/timeline/thread-context";
import {
  availableCheckpoints,
  restoreBlockedReason,
  turnOrder,
} from "@/components/timeline/turn-checkpoints";
import { useClientRuntime } from "@/lib/client-runtime";
import { turnInFlight } from "@/lib/turn";

export const useTimelineThreadValue = (snapshot: ThreadDetailSnapshot): TimelineThread => {
  const { threadId, projectId, items } = snapshot;
  const git = useGitAtoms();
  const registry = React.useContext(RegistryContext);

  const connection = useAtomValue(useClientRuntime().connectionStateAtom);
  const connected = AsyncResult.isSuccess(connection) && connection.value.status === "connected";

  const fold = snapshot.checkpoints;
  const listedResult = useAtomValue(
    git.checkpointsAtom({ projectId, threadId, revision: String(fold.length) }),
  );
  const listed =
    AsyncResult.isSuccess(listedResult) && listedResult.value._tag === "ok"
      ? listedResult.value.value
      : null;
  const checkpoints = React.useMemo(() => availableCheckpoints(fold, listed), [fold, listed]);

  const restoring = (snapshot.restoring ?? null) !== null;
  const wasRestoring = React.useRef(restoring);
  React.useEffect(() => {
    if (wasRestoring.current && !restoring) {
      git.refreshProject(registry, projectId);
    }
    wasRestoring.current = restoring;
  }, [restoring, git, registry, projectId]);

  // Joined into one string so the memo below sees a primitive that only
  // changes when a turn is added.
  const orderKey = React.useMemo(() => turnOrder(items).join(" "), [items]);
  const order = React.useMemo(
    () => (orderKey === "" ? [] : (orderKey.split(" ") as TurnId[])),
    [orderKey],
  );

  const blocked = restoreBlockedReason({
    connected,
    restoring,
    turnRunning: turnInFlight(snapshot),
  });

  return React.useMemo(
    () => ({
      threadId,
      projectId,
      checkpoints,
      restoreBlockedReason: blocked,
      turnOrder: order,
    }),
    [threadId, projectId, checkpoints, blocked, order],
  );
};
