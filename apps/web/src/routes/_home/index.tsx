import { createFileRoute } from "@tanstack/react-router";

import { ChatWorkspace } from "@/components/Chat/chat-workspace";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  return <ChatWorkspace />;
}
