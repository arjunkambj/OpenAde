import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "@/components/Layout/settings-layout";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});
