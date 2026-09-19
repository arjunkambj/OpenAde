import { createFileRoute } from "@tanstack/react-router";

import { StartThread } from "@/components/thread/start-thread";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  return <StartThread />;
}
