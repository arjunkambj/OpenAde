import { createFileRoute } from "@tanstack/react-router";

import { PermissionsPanel } from "@/components/Settings/permissions-panel";

export const Route = createFileRoute("/settings/permissions")({
  component: PermissionsPage,
});

function PermissionsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <PermissionsPanel />
      </div>
    </div>
  );
}
