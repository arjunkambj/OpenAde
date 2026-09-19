/**
 * The key legend under the composer. Enter and Shift+Enter are the textarea's
 * own behaviour and are fixed; queue and interrupt come from the server-owned
 * keybinding table, so rebinding them in Settings changes the legend too.
 */

import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";
import { detectModKey } from "@OpenAde/client-runtime/keybindings";

import { keycapsFor, shortcutFor } from "@/lib/keybindings";
import { useKeybindings } from "@/lib/shortcuts";

function BoundHint({ command, label }: { readonly command: string; readonly label: string }) {
  const keybindings = useKeybindings();
  const shortcut = shortcutFor(keybindings, command);
  const keys = shortcut === null ? [] : keycapsFor(shortcut, detectModKey());
  if (keys.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
      {label}
    </span>
  );
}

export function ComposerHints() {
  return (
    <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Kbd>⏎</Kbd> send
      </span>
      <span className="inline-flex items-center gap-1">
        <KbdGroup>
          <Kbd>⇧</Kbd>
          <Kbd>⏎</Kbd>
        </KbdGroup>
        newline
      </span>
      <BoundHint command="composer.queue" label="queue" />
      <BoundHint command="thread.interrupt" label="interrupt" />
    </div>
  );
}
