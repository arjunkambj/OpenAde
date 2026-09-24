import { createFileRoute } from "@tanstack/react-router";

import { isProjectDockPane, type DockPane } from "@/components/dock/dock-toggle";
import { StartThread } from "@/components/thread/start-thread";

export const Route = createFileRoute("/_home/")({
  // `pane` is the New task page's dock, as on a thread's route: present only
  // while the dock is open, on a tab a project's dock offers or `home` for
  // its launcher. Anything else — the Browser tab among them — reads as a
  // closed dock.
  validateSearch: (search): { pane?: DockPane } => ({
    pane: isProjectDockPane(search.pane) ? search.pane : undefined,
  }),
  component: HomePage,
});

function HomePage() {
  const { pane } = Route.useSearch();
  return <StartThread dockTab={pane} />;
}
