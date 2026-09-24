/**
 * The New task composer's send, as one "starting" span: from the click until
 * the first message is on its way — creating the thread, handing the
 * project's terminals to it, or cutting a worktree — the composer holds a
 * single `starting` state, which the page folds into its busy and working
 * flags. Each step has its own pending flag, but between them (the hand-over's
 * round trip, above all) none is set, and the send button would stop spinning
 * and wake for a moment. The first message's own `sending` takes over in the
 * same turn `starting` ends, so there is no gap.
 *
 * State alone cannot stop a second Enter before the re-render from starting
 * the same thread twice, so a ref closes that window.
 */

import * as React from "react";

export const useStartSend = ({
  canSend,
  blocked,
  start,
}: {
  /** There is something to send. */
  readonly canSend: boolean;
  /** Something else holds the composer: a pending create, a send, a worktree setup. */
  readonly blocked: boolean;
  /** Creates the thread and sends the first message, however the workspace asks. */
  readonly start: () => Promise<void>;
}) => {
  const [starting, setStarting] = React.useState(false);
  const startingRef = React.useRef(false);
  const send = async () => {
    if (!canSend || blocked || startingRef.current) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      await start();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };
  return { starting, send };
};
