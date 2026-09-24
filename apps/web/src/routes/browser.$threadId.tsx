/**
 * The pane's dev route — `/browser/:threadId`. In a real layout the pane sits
 * inside the thread view; this route drives it standalone, against a real
 * `browser.subscribe`.
 */
import * as React from "react";

import { createFileRoute } from "@tanstack/react-router";
import { decodeThreadId } from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";

import { BrowserPane } from "@/components/panes/browser/browser-pane";
import { useLoadedThreadList } from "@/state/hooks";

export const Route = createFileRoute("/browser/$threadId")({
  component: BrowserPage,
});

function BrowserPage() {
  const { threadId } = Route.useParams();
  const projectId =
    useLoadedThreadList()?.find((thread) => thread.threadId === threadId)?.projectId ?? null;
  const parsed = React.useMemo<ThreadId | null>(() => {
    try {
      return decodeThreadId(threadId);
    } catch {
      return null;
    }
  }, [threadId]);

  if (parsed === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        invalid thread id
      </div>
    );
  }
  return <BrowserPane threadId={parsed} projectId={projectId} />;
}
