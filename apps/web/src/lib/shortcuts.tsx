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
 * the composer's trigger menu stops Escape's propagation before it arrives
 * here — and it skips `defaultPrevented` events for the same reason. Do not
 * move it to capture. The interaction cards' `1`/`2`/`3`/`d`/`Escape` are rows
 * in the table like any other, told apart from each other and from
 * `thread.interrupt` by their `when` clauses rather than by who listens first.
 *
 * `when` clauses read the context `@/lib/keybinding-context` builds for each
 * press: focus, the surface it is in and whether an overlay is up come from
 * the event and the page; everything else is published by whichever component
 * knows it through `useKeybindingFlag`. A press where AltGr is typing a
 * character is not a chord and is left alone.
 *
 * A focused terminal keeps its keys. Inside `[data-context="terminal"]` the
 * listener only considers `terminal.toggle` and leaves every other chord —
 * `Escape`, `Mod+K`, `Mod+B` — to the shell without calling `preventDefault`
 * (`yieldsToTerminal` in `@/lib/keybindings`).
 */

import { useAtomValue } from "@effect/atom-react";
import { Kbd, KbdGroup } from "@OpenAde/ui/components/kbd";
import { useSidebar } from "@OpenAde/ui/components/sidebar";
import {
  detectModKey,
  isAltGraphTyping,
  resolveKeybinding,
} from "@OpenAde/client-runtime/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { makeCommandRegistry, type CommandRegistry } from "@/lib/command-registry";
import { focusSnapshot, keybindingContext } from "@/lib/keybinding-context";
import {
  effectiveKeybindings,
  keycapsFor,
  shortcutFor,
  TERMINAL_TOGGLE_COMMAND,
  yieldsToTerminal,
} from "@/lib/keybindings";

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
  addProject: "project.add",
  interrupt: "thread.interrupt",
  queue: "composer.queue",
  terminal: TERMINAL_TOGGLE_COMMAND,
} as const;

export type ShortcutId = keyof typeof SHORTCUT_COMMANDS;

const RegistryContext = React.createContext<CommandRegistry | null>(null);

/** The live table: the shipped defaults with the stored overrides layered on. */
export function useKeybindings(): ReadonlyArray<Keybinding> {
  const { keybindingsAtom } = useClientRuntime();
  const result = useAtomValue(keybindingsAtom);
  const table = AsyncResult.isSuccess(result) ? result.value : [];
  return React.useMemo(() => effectiveKeybindings(table), [table]);
}

/** Mounted once, above the routes. Owns the window listener and the registry. */
export function KeybindingsProvider({ children }: { readonly children: React.ReactNode }) {
  const registry = React.useMemo<CommandRegistry>(() => makeCommandRegistry(), []);
  const keybindings = useKeybindings();
  const keybindingsRef = React.useRef(keybindings);
  keybindingsRef.current = keybindings;

  React.useEffect(() => {
    const modKey = detectModKey();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        isAltGraphTyping(event, modKey)
      ) {
        return;
      }
      const snapshot = focusSnapshot(event);
      const context = keybindingContext(snapshot, registry.flag, modKey === "meta");
      // Filtered rather than checked after resolving, so a yielded binding
      // cannot shadow a toggle bound to the same chord further down.
      const table =
        snapshot.surface === "terminal"
          ? keybindingsRef.current.filter(
              (entry) => !yieldsToTerminal(entry.command, snapshot.surface),
            )
          : keybindingsRef.current;
      const binding = resolveKeybinding(table, event, context, modKey);
      const handler = binding === null ? undefined : registry.resolve(binding.command);
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
 * Answer `command` for as long as this component is mounted. Two surfaces may
 * claim one id: the newest answers, and unmounting hands it back to whoever
 * held it before rather than leaving it unanswered — see `@/lib/command-registry`.
 */
export function useKeybindingCommand(command: string, handler: () => void): void {
  const registry = React.useContext(RegistryContext);
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  React.useEffect(() => {
    if (registry === null) {
      return;
    }
    return registry.register(command, () => handlerRef.current());
  }, [registry, command]);
}

/**
 * Fire a command by id, as if its chord had been pressed. A command no mounted
 * surface answers is a no-op — the same rule the listener follows — so the
 * palette can offer an entry without knowing whether this route has the
 * surface behind it.
 */
export function useKeybindingDispatch(): (command: string) => void {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (command: string) => {
      registry?.resolve(command)?.();
    },
    [registry],
  );
}

/**
 * Whether a mounted surface currently answers `command`.
 *
 * The registry is a plain map, not reactive, so this is read at render time
 * and is only trustworthy for a component that mounts when it needs the
 * answer — the palette, whose dialog content unmounts on close and is built
 * fresh on every open. It exists so the palette can leave out an entry whose
 * surface is not on this route, rather than offer a row that does nothing.
 */
export function useKeybindingHandled(command: string): boolean {
  const registry = React.useContext(RegistryContext);
  return registry?.has(command) ?? false;
}

/**
 * Claims `sidebar.toggle` for the `SidebarProvider` above it, so the chord
 * acts on the sidebar the user is actually looking at. Mounted by the home
 * layout, whose sidebar is the collapsible one; the settings pages have a
 * `collapsible="none"` sidebar, so there the command is deliberately left
 * unanswered rather than bound to a no-op.
 */
export function SidebarToggleShortcut() {
  const { toggleSidebar } = useSidebar();
  useKeybindingCommand(SHORTCUT_COMMANDS.toggle, toggleSidebar);
  return null;
}

/**
 * Publish a `when`-clause flag while this component is mounted. The value is
 * read through a ref rather than re-registered on every change, so a publisher
 * keeps its place in the stack; a second publisher of the same flag wins while
 * it is mounted and hands the flag back when it goes.
 */
export function useKeybindingFlag(name: string, value: boolean | string): void {
  const registry = React.useContext(RegistryContext);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  React.useEffect(() => {
    if (registry === null) {
      return;
    }
    return registry.publish(name, () => valueRef.current);
  }, [registry, name]);
}

/** The chord bound to one of the shell's commands, in keycaps. */
export function useShortcutKeys(id: ShortcutId): ReadonlyArray<string> {
  const keybindings = useKeybindings();
  const shortcut = shortcutFor(keybindings, SHORTCUT_COMMANDS[id]);
  return shortcut === null ? [] : keycapsFor(shortcut, detectModKey());
}

export function ShortcutKbd({ id }: { id: ShortcutId }) {
  const keys = useShortcutKeys(id);
  return keys.length === 0 ? null : <Keycaps caps={keys} />;
}

/**
 * Every chord the live table binds to `commands`, in table order, each as
 * keycaps — user overrides applied, so a hint drawn from it never names a key
 * the user has moved. A command with no binding contributes nothing.
 */
export function useCommandKeycaps(
  commands: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  const keybindings = useKeybindings();
  const modKey = detectModKey();
  return keybindings
    .filter((binding) => commands.includes(binding.command))
    .map((binding) => keycapsFor(binding.shortcut, modKey))
    .filter((caps) => caps.length > 0);
}

function Keycaps({ caps }: { readonly caps: ReadonlyArray<string> }) {
  return (
    <KbdGroup>
      {caps.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}

/**
 * The chords bound to `commands`, one keycap group each; nothing when none is
 * bound. `first` draws only the first chord, for a button's own label.
 */
export function CommandKeys({
  commands,
  first = false,
}: {
  readonly commands: ReadonlyArray<string>;
  readonly first?: boolean;
}) {
  const chords = useCommandKeycaps(commands);
  const shown = first ? chords.slice(0, 1) : chords;
  if (shown.length === 0) {
    return null;
  }
  return (
    <>
      {shown.map((caps) => (
        <Keycaps key={caps.join("+")} caps={caps} />
      ))}
    </>
  );
}
