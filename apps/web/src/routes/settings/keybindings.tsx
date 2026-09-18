import { createFileRoute } from "@tanstack/react-router";

import { Kbd } from "@OpenAde/ui/components/kbd";

import { KeybindingsEditor } from "@/components/keybindings/keybindings-editor";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsPage,
});

/**
 * The real editor, not the reduced panel this route used to mount. The reviewed
 * one — conflict flagging, per-row reset, invalid-chord marking, a draft with
 * Revert and Save — was only reachable from the DEV-only composer fixture,
 * which is stripped from the packaged app; what shipped had none of that and
 * wrote the whole table on every individual edit.
 */
function KeybindingsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <div>
          <h1 className="text-2xl font-medium">Keybindings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Command-to-shortcut bindings. The notation is <Kbd>Cmd+Shift+B</Kbd> — Cmd is the
            platform modifier. Two bindings on one chord are flagged, and edits are a draft until
            you save.
          </p>
        </div>
        <KeybindingsEditor />
      </div>
    </div>
  );
}
