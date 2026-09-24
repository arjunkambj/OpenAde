/**
 * Where the browser pane shows a page: an empty box the host lays the
 * thread's selected tab over. The webview itself never renders here — see
 * `./browser-host`. Whatever `children` the pane passes (an empty state) sits
 * underneath, and shows while the thread has no tab.
 */
import * as React from "react";

import { useSetBrowserSlot } from "@/state/browser-tabs";

export function BrowserSlot({
  threadId,
  children,
}: {
  readonly threadId: string;
  readonly children?: React.ReactNode;
}) {
  const setSlot = useSetBrowserSlot();
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setSlot({ threadId, element });
    // Only clear what is still ours: the next pane may have registered first.
    return () => setSlot((current) => (current?.element === element ? null : current));
  }, [threadId, setSlot]);

  return (
    <div ref={ref} data-browser-slot={threadId} className="relative flex min-h-0 flex-1">
      {children}
    </div>
  );
}
