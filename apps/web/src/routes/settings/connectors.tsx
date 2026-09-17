import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsPanel } from "@/components/Settings/connectors-panel";

export const Route = createFileRoute("/settings/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <ConnectorsPanel />
      </div>
    </div>
  );
}
