/**
 * Where a link the terminal printed opens: the thread's own browser pane. The
 * dock switches to its Browser tab and the pane is sent a human `navigate`,
 * the same input its address bar sends; the browser service starts its
 * browser on that first navigation if none is running yet.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ThreadId } from "@poseidon/contracts/ids";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

export function useOpenInBrowserPane(
  threadId: ThreadId,
  showBrowser: () => void,
): (url: string) => void {
  const navigate = useAtomSet(getAppAtoms().sendBrowserInput);
  const showRef = React.useRef(showBrowser);
  showRef.current = showBrowser;
  return React.useCallback(
    (url: string) => {
      showRef.current();
      navigate({ threadId, input: { kind: "navigate", url } });
    },
    [navigate, threadId],
  );
}
