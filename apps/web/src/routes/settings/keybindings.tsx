import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsPanel } from "@/components/Settings/keybindings-panel";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsPage,
});

function KeybindingsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <KeybindingsPanel />
      </div>
    </div>
  );
}
