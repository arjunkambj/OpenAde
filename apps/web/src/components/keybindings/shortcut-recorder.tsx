/**
 * The capture field for one keybinding row. Click to arm; the next keydown
 * becomes the chord (any key, Escape included — arming again or blurring
 * cancels instead). The notation comes from `formatEventAsShortcut`, the same
 * module the matcher uses, so what the editor shows is what will match.
 */

import { Button } from "@OpenAde/ui/components/button";
import { Kbd } from "@OpenAde/ui/components/kbd";
import { detectModKey, formatEventAsShortcut } from "@OpenAde/client-runtime/keybindings";
import * as React from "react";

export function ShortcutRecorder({
  value,
  onRecord,
}: {
  readonly value: string;
  readonly onRecord: (shortcut: string) => void;
}) {
  const [armed, setArmed] = React.useState(false);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!armed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const shortcut = formatEventAsShortcut(event, detectModKey());
    if (shortcut === null) {
      // A lone modifier — keep listening for the rest of the chord.
      return;
    }
    setArmed(false);
    onRecord(shortcut);
  };

  return (
    <Button
      type="button"
      variant={armed ? "secondary" : "ghost"}
      size="sm"
      aria-label={armed ? "Recording — press the new shortcut" : `Change shortcut ${value}`}
      aria-live="polite"
      className="min-w-24 justify-start"
      onClick={() => setArmed((current) => !current)}
      onBlur={() => setArmed(false)}
      onKeyDown={onKeyDown}
    >
      {armed ? <span className="text-muted-foreground">press keys…</span> : <Kbd>{value}</Kbd>}
    </Button>
  );
}
