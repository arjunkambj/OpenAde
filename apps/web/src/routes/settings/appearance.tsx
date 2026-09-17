import { createFileRoute } from "@tanstack/react-router";

import { ThemeCards } from "@/components/Settings/theme-cards";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearancePage,
});

function AppearancePage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <ThemeCards />
      </div>
    </div>
  );
}
