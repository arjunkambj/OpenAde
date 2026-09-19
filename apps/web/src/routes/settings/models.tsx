import { createFileRoute } from "@tanstack/react-router";

import { ModelsPanel } from "@/components/Settings/models-panel";

export const Route = createFileRoute("/settings/models")({
  component: ModelsPage,
});

function ModelsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <ModelsPanel />
      </div>
    </div>
  );
}
