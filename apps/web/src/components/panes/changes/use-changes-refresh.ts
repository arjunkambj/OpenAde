/**
 * When the Changes pane rereads git on its own.
 *
 * Nothing here refetches on a command receipt. The git atoms only fetch on a
 * connected epoch, and both writes that move the worktree — a restore and an
 * agent turn — finish after the command that started them: the checkpoint
 * reactor runs `hook.restore` off the durable `thread.checkpoint.restored`
 * event, and a turn touches files until it completes. So the pane watches the
 * thread snapshot instead: a restore records the sequence it was accepted at
 * and refetches once the snapshot passes it, and a turn refetches when
 * `currentTurnId` falls back to null.
 */

import * as React from "react";

import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";

/** Runs `refresh` after a restore lands and after a turn ends; returns the restore's `onAccepted`. */
export const useChangesRefresh = (snapshot: ThreadDetailView, refresh: () => void) => {
  // The sequence the pane was at when a restore was accepted, or null when no
  // restore is outstanding. The `thread.checkpoint.restored` event bumps
  // `snapshotSequence`, and the reactor's git work runs off that same event, so
  // a later sequence is the earliest point worth rereading the worktree at.
  const [restoreAcceptedAt, setRestoreAcceptedAt] = React.useState<number | null>(null);
  const sequence = snapshot.snapshotSequence;
  React.useEffect(() => {
    if (restoreAcceptedAt !== null && sequence > restoreAcceptedAt) {
      setRestoreAcceptedAt(null);
      refresh();
    }
  }, [sequence, restoreAcceptedAt, refresh]);

  // A finished turn has written whatever it was going to write.
  const currentTurnId = snapshot.currentTurnId;
  const lastTurnId = React.useRef(currentTurnId);
  React.useEffect(() => {
    const previous = lastTurnId.current;
    lastTurnId.current = currentTurnId;
    if (previous !== null && currentTurnId === null) {
      refresh();
    }
  }, [currentTurnId, refresh]);

  return React.useCallback(() => setRestoreAcceptedAt(sequence), [sequence]);
};
