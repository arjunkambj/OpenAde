import { createFileRoute } from "@tanstack/react-router";

import { CustomizeLayout } from "@/components/customize/customize-layout";

export const Route = createFileRoute("/_home/customize")({
  component: CustomizeLayout,
});
