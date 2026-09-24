import { createFileRoute } from "@tanstack/react-router";

import { BrowserPanel } from "@/components/Settings/browser-panel";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserPage,
});

function BrowserPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <BrowserPanel />
      </div>
    </div>
  );
}
