/**
 * The keybinding table as data: which table to dispatch against, and how one
 * stored chord is drawn as keycaps.
 *
 * Both halves are pure so they can be tested without a DOM. The React side —
 * the provider, the command registry and `ShortcutKbd` — lives in
 * `@/lib/shortcuts`, which is the only place that listens for keys.
 */

import { parseShortcut, type ModKey } from "@OpenAde/client-runtime/keybindings";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "@OpenAde/contracts/settings";

/**
 * The table to resolve keypresses against. An empty table means the server
 * has not seeded one yet (or a migration dropped it), and a renderer with no
 * bindings at all has no shortcuts — so the shipped defaults stand in. Once
 * the table has any row it is authoritative, and a binding the user removed
 * stays removed.
 */
export const effectiveKeybindings = (
  table: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => (table.length === 0 ? DEFAULT_KEYBINDINGS : table);

/** The chord bound to a command, or null when the table does not bind it. */
export const shortcutFor = (table: ReadonlyArray<Keybinding>, command: string): string | null =>
  table.find((binding) => binding.command === command)?.shortcut ?? null;

const MAC_MODIFIERS: Readonly<Record<string, string>> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const OTHER_MODIFIERS: Readonly<Record<string, string>> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  enter: "↵",
  escape: "Esc",
  backspace: "⌫",
  delete: "Del",
  tab: "Tab",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
};

/**
 * `Cmd+Shift+B` → `["⌘", "⇧", "B"]` on macOS, `["Ctrl", "Shift", "B"]`
 * elsewhere. An unparseable chord draws nothing rather than a wrong hint.
 */
export const keycapsFor = (shortcut: string, modKey: ModKey): ReadonlyArray<string> => {
  const parsed = parseShortcut(shortcut);
  if (parsed === null) {
    return [];
  }
  const names = modKey === "meta" ? MAC_MODIFIERS : OTHER_MODIFIERS;
  const caps: Array<string> = [];
  if (parsed.mod) {
    caps.push(names.mod!);
  }
  // `Cmd` already resolves to Control off macOS — do not draw it twice.
  if (parsed.ctrl && !(parsed.mod && modKey === "ctrl")) {
    caps.push(names.ctrl!);
  }
  if (parsed.alt) {
    caps.push(names.alt!);
  }
  if (parsed.shift) {
    caps.push(names.shift!);
  }
  const label = KEY_LABELS[parsed.key];
  caps.push(
    label ??
      (parsed.key.length === 1
        ? parsed.key.toUpperCase()
        : `${parsed.key[0]!.toUpperCase()}${parsed.key.slice(1)}`),
  );
  return caps;
};
