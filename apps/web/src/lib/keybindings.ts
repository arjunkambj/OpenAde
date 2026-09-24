/**
 * The keybinding table as data: which table to dispatch against, and how one
 * stored chord is drawn as keycaps.
 *
 * Both halves are pure so they can be tested without a DOM. The React side —
 * the provider, the command registry and `ShortcutKbd` — lives in
 * `@/lib/shortcuts`, which is the only place that listens for keys.
 */

import { parseShortcut, type ModKey } from "@OpenAde/client-runtime/keybindings";
import { DEFAULT_KEYBINDINGS, resolveKeymap } from "@OpenAde/contracts/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";

/**
 * The table to resolve keypresses against: the shipped defaults with the
 * user's overrides layered on (`resolveKeymap`). The server stores only the
 * overrides, so an empty list is every default, and a default added in a
 * later build reaches an install with no action from the user; a binding the
 * user removed is stored as a `-command` row and stays removed.
 */
export const effectiveKeybindings = (
  overrides: ReadonlyArray<Keybinding>,
): ReadonlyArray<Keybinding> => resolveKeymap(DEFAULT_KEYBINDINGS, overrides);

/** The command a focused terminal still lets the app answer. */
export const TERMINAL_TOGGLE_COMMAND = "terminal.toggle";

/**
 * Whether the app leaves a chord to the focused element instead of answering
 * `command`. A shell owns its keys — `Escape` is vim's, not `thread.interrupt`,
 * and `Cmd+K` or `Cmd+B` mean something to the program running there — so with
 * focus inside `[data-context="terminal"]` every binding yields except the
 * toggle, which has to work from inside the terminal to hide it again. Any
 * other focus, the composer's included, yields nothing.
 */
export const yieldsToTerminal = (command: string, focusedContext: string | undefined): boolean =>
  focusedContext === "terminal" && command !== TERMINAL_TOGGLE_COMMAND;

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
