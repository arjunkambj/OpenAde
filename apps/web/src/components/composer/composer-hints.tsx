/**
 * The key legend under the composer. It mirrors the server-owned keybinding
 * table's defaults — the editor can rebind these, so the hints are the
 * notation, not a promise.
 */

import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";

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
      <span className="inline-flex items-center gap-1">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⏎</Kbd>
        </KbdGroup>
        queue
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>esc</Kbd> interrupt
      </span>
    </div>
  );
}
