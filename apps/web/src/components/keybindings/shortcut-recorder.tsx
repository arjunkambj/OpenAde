/**
 * The capture field for one keybinding. Click to arm; the next keydown
 * becomes the chord (any key, Escape included — arming again or blurring
 * cancels instead). The notation comes from `formatEventAsShortcut`, the same
 * module the matcher uses, so what the editor shows is what will match. The
 * armed press is stopped here, so the global listener never acts on it.
 *
 * With an empty `value` it is an "add" control: `placeholder` is drawn in
 * place of the keycaps.
 */

import { Button } from "@poseidon/ui/components/button";
import { Kbd } from "@poseidon/ui/components/kbd";
import { detectModKey, formatEventAsShortcut } from "@poseidon/client-runtime/keybindings";
import * as React from "react";

import { keycapsFor } from "@/lib/keybindings";
import { Keycaps } from "@/lib/shortcuts";

export function ShortcutRecorder({
  value,
  onRecord,
  placeholder,
  label,
}: {
  readonly value: string;
  readonly onRecord: (shortcut: string) => void;
  readonly placeholder?: React.ReactNode;
  /** The accessible name while idle; defaults to "Change shortcut …". */
  readonly label?: string;
}) {
  const [armed, setArmed] = React.useState(false);
  const caps = keycapsFor(value, detectModKey());

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!armed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const shortcut = formatEventAsShortcut(event, detectModKey());
    if (shortcut === null) {
      // A lone modifier, or a key the notation cannot write (Super off
      // macOS) — keep listening for a chord it can.
      return;
    }
    setArmed(false);
    onRecord(shortcut);
  };

  const idle =
    value === "" ? placeholder : caps.length === 0 ? <Kbd>{value}</Kbd> : <Keycaps caps={caps} />;

  return (
    <Button
      type="button"
      variant={armed ? "secondary" : "ghost"}
      size="sm"
      aria-label={
        armed ? "Recording — press the new shortcut" : (label ?? `Change shortcut ${value}`)
      }
      aria-live="polite"
      className={value === "" ? undefined : "min-w-24 justify-start"}
      onClick={() => setArmed((current) => !current)}
      onBlur={() => setArmed(false)}
      onKeyDown={onKeyDown}
    >
      {armed ? <span className="text-muted-foreground">press keys…</span> : idle}
    </Button>
  );
}
