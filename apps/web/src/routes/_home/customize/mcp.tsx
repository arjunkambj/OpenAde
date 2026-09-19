import { createFileRoute } from "@tanstack/react-router";

import { McpTab } from "@/components/customize/mcp-tab";

export const Route = createFileRoute("/_home/customize/mcp")({
  component: McpTab,
});
