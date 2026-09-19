import { createFileRoute } from "@tanstack/react-router";

import { SkillsTab } from "@/components/customize/skills-tab";

export const Route = createFileRoute("/_home/customize/skills")({
  component: SkillsTab,
});
