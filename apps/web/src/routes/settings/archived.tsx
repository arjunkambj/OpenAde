import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "@/components/Settings/archived-threads-panel";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedPage,
});

function ArchivedPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <ArchivedThreadsPanel />
      </div>
    </div>
  );
}
