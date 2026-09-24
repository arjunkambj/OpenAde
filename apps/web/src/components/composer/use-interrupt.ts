/**
 * Stopping the running turn.
 *
 * Both halves of the deliverable end here: the toolbar's Stop button and the
 * `thread.interrupt` binding. `interrupting` is a UI latch, not a claim about
 * the turn — it clears when the doc stops reporting a current turn, because a
 * turn is only really over once the server says so. A rejected or unreachable
 * dispatch clears it immediately so the button can be pressed again.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";
import * as React from "react";

import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";

export interface Interrupt {
  readonly interrupting: boolean;
  readonly interrupt: () => void;
}

export function useInterrupt(
  threadId: ThreadId,
  running: boolean,
  onError: (message: string | null) => void,
): Interrupt {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [interrupting, setInterrupting] = React.useState(false);
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    if (!running) {
      setInterrupting(false);
    }
  }, [running]);

  const interrupt = React.useCallback(() => {
    if (!running) {
      return;
    }
    setInterrupting(true);
    onErrorRef.current(null);
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.turn.interrupt",
      threadId,
    }).then(
      (receipt) => {
        const rejected = receiptError(receipt, "the server rejected the interrupt");
        if (rejected !== null) {
          setInterrupting(false);
        }
        onErrorRef.current(rejected);
      },
      () => {
        setInterrupting(false);
        onErrorRef.current(DISPATCH_UNREACHABLE);
      },
    );
  }, [dispatch, running, threadId]);

  return { interrupting, interrupt };
}
