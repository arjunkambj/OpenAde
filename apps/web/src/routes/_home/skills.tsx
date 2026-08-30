import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_home/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  return <div className="flex flex-1" />;
}
