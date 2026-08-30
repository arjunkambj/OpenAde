import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/uses")({
  component: UsesPage,
});

function UsesPage() {
  return <div className="flex flex-1 flex-col px-8 py-10" />;
}
