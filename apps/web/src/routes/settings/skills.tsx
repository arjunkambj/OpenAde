import { createFileRoute } from "@tanstack/react-router";

import { SkillsPanel } from "@/components/Settings/skills-panel";

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsPage,
});

function SettingsSkillsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <SkillsPanel />
      </div>
    </div>
  );
}
