import { createFileRoute } from "@tanstack/react-router";

import { GitPanel } from "@/components/Settings/git-panel";

export const Route = createFileRoute("/settings/git")({
  component: GitPage,
});

function GitPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <GitPanel />
      </div>
    </div>
  );
}
