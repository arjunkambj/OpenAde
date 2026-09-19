import { createFileRoute } from "@tanstack/react-router";

import { GeneralPanel } from "@/components/Settings/general-panel";

export const Route = createFileRoute("/settings/")({
  component: GeneralPage,
});

function GeneralPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <GeneralPanel />
      </div>
    </div>
  );
}
