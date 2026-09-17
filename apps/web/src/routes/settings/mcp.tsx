import { createFileRoute } from "@tanstack/react-router";

import { McpPanel } from "@/components/Settings/mcp-panel";

export const Route = createFileRoute("/settings/mcp")({
  component: McpPage,
});

function McpPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <McpPanel />
      </div>
    </div>
  );
}
