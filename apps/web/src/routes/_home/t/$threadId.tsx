import { createFileRoute, notFound } from "@tanstack/react-router";

import { decodeThreadId } from "@OpenAde/contracts/ids";

import { isDockTab, type DockTab } from "@/components/dock/right-dock";
import { ThreadView } from "@/components/thread/thread-view";

export const Route = createFileRoute("/_home/t/$threadId")({
  params: {
    // The id arrives as a raw string; anything that is not a UUIDv7 is a 404,
    // not a subscription.
    parse: (params) => {
      try {
        return { threadId: decodeThreadId(params.threadId) };
      } catch {
        throw notFound();
      }
    },
  },
  // `pane` is optional on purpose: links that never mention the dock keep
  // working, and `?pane=` is only present while the dock is open.
  validateSearch: (search): { pane?: DockTab } => ({
    pane: isDockTab(search.pane) ? search.pane : undefined,
  }),
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { pane } = Route.useSearch();
  return <ThreadView threadId={threadId} dockTab={pane} />;
}
