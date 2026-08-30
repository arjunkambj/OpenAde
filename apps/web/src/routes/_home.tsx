import { createFileRoute } from "@tanstack/react-router";

import { HomeLayout } from "@/components/Layout/home-layout";

export const Route = createFileRoute("/_home")({
  component: HomeLayout,
});
