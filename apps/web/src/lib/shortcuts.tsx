/**
 * The one keybinding mechanism: the server-owned table → the client-runtime
 * matcher → one window listener, mounted once at the app root.
 *
 * Nothing else in the renderer may listen for a shortcut. A surface that owns
 * a command calls `useKeybindingCommand("thread.interrupt", …)` while it is
 * mounted; the listener looks the pressed chord up in the table, finds the
 * command id, and calls whatever handler is registered for it. An id with no
 * handler resolves and is then ignored, so a binding for a surface that is
 * not on screen is inert rather than an error.
 *
 * The listener runs in bubble phase so focused controls get first refusal —
 * the composer's trigger menu stops Escape's propagation, and an interaction
 * card's capture-phase listener settles the key before it ever arrives here —
 * and it skips `defaultPrevented` events for the same reason. Do not move it
 * to capture.
 *
 * `when` clauses read context flags: `composerFocus` is derived from the
 * focused element's `data-context`, everything else is published by whichever
 * component knows it through `useKeybindingFlag`.
 */

import { useAtomValue } from "@effect/atom-react";
import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";
import { detectModKey, resolveKeybinding } from "@OpenAde/client-runtime/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { effectiveKeybindings, keycapsFor, shortcutFor } from "@/lib/keybindings";

/**
 * The command ids the shell's own surfaces answer to. Kept as a map so the
 * shell can keep asking for "the search shortcut" while the binding itself
 * lives in the settings table.
 */
export const SHORTCUT_COMMANDS = {
  search: "commandPalette.toggle",
  toggle: "sidebar.toggle",
  newChat: "thread.new",
  skills: "skills.open",
  settings: "settings.open",
} as const;

export type ShortcutId = keyof typeof SHORTCUT_COMMANDS;

interface Registry {
  readonly commands: Map<string, () => void>;
  readonly flags: Map<string, boolean | string>;
}

const RegistryContext = React.createContext<Registry | null>(null);

const focusedContext = (target: EventTarget | null): string | undefined =>
  target instanceof HTMLElement
    ? (target.closest("[data-context]")?.getAttribute("data-context") ?? undefined)
    : undefined;

/** The live table, with the shipped defaults standing in for an empty one. */
export function useKeybindings(): ReadonlyArray<Keybinding> {
  const { keybindingsAtom } = useClientRuntime();
  const result = useAtomValue(keybindingsAtom);
  const table = AsyncResult.isSuccess(result) ? result.value : [];
  return React.useMemo(() => effectiveKeybindings(table), [table]);
}

/** Mounted once, above the routes. Owns the window listener and the registry. */
export function KeybindingsProvider({ children }: { readonly children: React.ReactNode }) {
  const registry = React.useMemo<Registry>(() => ({ commands: new Map(), flags: new Map() }), []);
  const keybindings = useKeybindings();
  const keybindingsRef = React.useRef(keybindings);
  keybindingsRef.current = keybindings;

  React.useEffect(() => {
    const modKey = detectModKey();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }
      const context = (name: string): boolean | string | undefined =>
        name === "composerFocus"
          ? focusedContext(event.target) === "composer"
          : registry.flags.get(name);
      const binding = resolveKeybinding(keybindingsRef.current, event, context, modKey);
      const handler = binding === null ? undefined : registry.commands.get(binding.command);
      if (handler === undefined) {
        return;
      }
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry]);

  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/**
 * Answer `command` for as long as this component is mounted. Registering the
 * same id twice is last-one-wins; unmounting only clears the entry that is
 * still the caller's, so a remount during a transition cannot blank it.
 */
export function useKeybindingCommand(command: string, handler: () => void): void {
  const registry = React.useContext(RegistryContext);
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  React.useEffect(() => {
    if (registry === null) {
      return;
    }
    const entry = () => handlerRef.current();
    registry.commands.set(command, entry);
    return () => {
      if (registry.commands.get(command) === entry) {
        registry.commands.delete(command);
      }
    };
  }, [registry, command]);
}

/** Publish a `when`-clause flag while this component is mounted. */
export function useKeybindingFlag(name: string, value: boolean | string): void {
  const registry = React.useContext(RegistryContext);
  React.useEffect(() => {
    if (registry === null) {
      return;
    }
    registry.flags.set(name, value);
    return () => {
      registry.flags.delete(name);
    };
  }, [registry, name, value]);
}

/** The chord bound to one of the shell's commands, in keycaps. */
export function useShortcutKeys(id: ShortcutId): ReadonlyArray<string> {
  const keybindings = useKeybindings();
  const shortcut = shortcutFor(keybindings, SHORTCUT_COMMANDS[id]);
  return shortcut === null ? [] : keycapsFor(shortcut, detectModKey());
}

export function ShortcutKbd({ id }: { id: ShortcutId }) {
  const keys = useShortcutKeys(id);
  if (keys.length === 0) {
    return null;
  }
  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}
