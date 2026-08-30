import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_home/")({
  component: HomePage,
});

function HomePage() {
  return <div className="flex flex-1" />;
}
