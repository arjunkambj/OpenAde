import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@poseidon/ui/components/button";
import { Kbd } from "@poseidon/ui/components/kbd";
import { detectModKey } from "@poseidon/client-runtime/keybindings";

import { KeybindingsEditor } from "@/components/keybindings/keybindings-editor";
import { CommandKbd, useKeybindingDispatch } from "@/lib/shortcuts";
import { Keyboard } from "@honeyicons/react";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsPage,
});

/**
 * The keybindings editor, plus the way into the read-only shortcuts sheet: the
 * button fires `shortcuts.open`, the same command as its chord, so the sheet
 * has one owner (`ShortcutsDialog`, mounted at the app root).
 */
function KeybindingsPage() {
  const fire = useKeybindingDispatch();
  const mod = detectModKey() === "meta" ? "⌘" : "Ctrl";

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-medium">Keybindings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <Kbd>Mod</Kbd> is <Kbd>{mod}</Kbd> on this computer. Changes apply when you save.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => fire("shortcuts.open")}>
            <Keyboard variant="bold" />
            Keyboard shortcuts
            <CommandKbd command="shortcuts.open" />
          </Button>
        </div>
        <KeybindingsEditor />
      </div>
    </div>
  );
}
