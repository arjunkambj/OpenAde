import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_home/skill")({
  component: SkillPage,
});

function SkillPage() {
  return <div className="flex flex-1" />;
}
