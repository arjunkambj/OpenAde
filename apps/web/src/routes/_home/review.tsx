import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_home/review")({
  component: ReviewPage,
});

function ReviewPage() {
  return <div className="flex flex-1" />;
}
