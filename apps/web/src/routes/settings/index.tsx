import { createFileRoute } from "@tanstack/react-router";

import { ThemeCards } from "@/components/Settings/theme-cards";

export const Route = createFileRoute("/settings/")({
  component: GeneralPage,
});

function GeneralPage() {
  return (
    <div className="flex flex-1 flex-col px-8 py-10">
      <ThemeCards />
    </div>
  );
}
