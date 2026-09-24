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
import { Kbd } from "@poseidon/ui/components/kbd";
import { useSidebar } from "@poseidon/ui/components/sidebar";
import {
  detectModKey,
  evaluateWhen,
  isAltGraphTyping,
  resolveKeybinding,
  type ModKey,
} from "@poseidon/client-runtime/keybindings";
import type { Keybinding } from "@poseidon/contracts/settings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import {
  makeCommandRegistry,
  type CommandHandler,
  type CommandOrigin,
  type CommandRegistry,
} from "@/lib/command-registry";
import { focusSnapshot, keybindingContext, type FocusSnapshot } from "@/lib/keybinding-context";
import { effectiveKeybindings, keycapsFor, shortcutFor, yieldsToTerminal } from "@/lib/keybindings";

const RegistryContext = React.createContext<CommandRegistry | null>(null);

/**
 * The handler a keypress would run: the command the live table resolves for
 * it in this press's context, if a mounted surface answers that command.
 * AltGr typing a character answers nothing.
 */
const handlerFor = (
  registry: CommandRegistry,
  keybindings: ReadonlyArray<Keybinding>,
  event: KeyboardEvent,
  modKey: ModKey,
): CommandHandler | undefined => {
  if (isAltGraphTyping(event, modKey)) {
    return undefined;
  }
  const snapshot = focusSnapshot(event);
  const context = keybindingContext(snapshot, registry.flag, modKey === "meta");
  // Filtered rather than checked after resolving, so a yielded binding
  // cannot shadow a toggle bound to the same chord further down.
  const table =
    snapshot.surface === "terminal"
      ? keybindings.filter((entry) => !yieldsToTerminal(entry.command, snapshot.surface))
      : keybindings;
  const binding = resolveKeybinding(table, event, context, modKey);
  return binding === null ? undefined : registry.resolve(binding.command);
};

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
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }
      const handler = handlerFor(registry, keybindingsRef.current, event, modKey);
      if (handler === undefined) {
        return;
      }
      event.preventDefault();
      handler("chord");
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
export function useKeybindingCommand(
  command: string,
  handler: (origin: CommandOrigin) => void,
): void {
  const registry = React.useContext(RegistryContext);
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  React.useEffect(() => {
    if (registry === null) {
      return;
    }
    return registry.register(command, (origin) => handlerRef.current(origin));
  }, [registry, command]);
}

/**
 * Fire a command by id, as if its chord had been pressed. A command no mounted
 * surface answers is a no-op — the same rule the listener follows — so the
 * palette can offer an entry without knowing whether this route has the
 * surface behind it. The handler is told it was a `pick`, not a `chord`.
 */
export function useKeybindingDispatch(): (command: string) => void {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (command: string) => {
      registry?.resolve(command)?.("pick");
    },
    [registry],
  );
}

/**
 * Whether the listener would act on `event` once it bubbles up: the live
 * table binds its chord in this context and a mounted surface answers the
 * command. A field that gives a chord its own meaning when nothing claims it —
 * the composer's Ctrl+Enter — asks this first, so a rebinding still wins.
 */
export function useKeymapAnswers(): (event: KeyboardEvent) => boolean {
  const registry = React.useContext(RegistryContext);
  const keybindings = useKeybindings();
  return React.useCallback(
    (event: KeyboardEvent) =>
      registry !== null && handlerFor(registry, keybindings, event, detectModKey()) !== undefined,
    [registry, keybindings],
  );
}

/** The page as the palette sees it: focus in its own input, no surface named. */
const PALETTE_FOCUS: FocusSnapshot = { editable: false, surface: undefined, overlayOpen: false };

/**
 * Whether the palette may offer `command` right now: a mounted surface answers
 * it, and `when` — a clause over published flags, if given — holds. Focus keys
 * and `dialogOpen` read false, since they describe where the user was before
 * the palette took the focus, not what the command can act on.
 *
 * The registry is a plain map, not reactive, so the answer is read at render
 * time and is only trustworthy for a component that mounts when it needs it —
 * the palette, whose dialog content unmounts on close and is built fresh on
 * every open. It exists so the palette leaves out an entry whose surface is not
 * on this route, rather than offer a row that does nothing.
 */
export function useCommandAvailable(): (command: string, when?: string) => boolean {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (command: string, when?: string) => {
      if (registry === null || !registry.has(command)) {
        return false;
      }
      if (when === undefined) {
        return true;
      }
      const context = keybindingContext(PALETTE_FOCUS, registry.flag, detectModKey() === "meta");
      return evaluateWhen(when, context);
    },
    [registry],
  );
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
  useKeybindingCommand("sidebar.toggle", toggleSidebar);
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

/**
 * The first chord the live table binds to `command`, as keycaps — user
 * overrides applied — or nothing when it is unbound. For a button's tooltip or
 * a palette row, which name one key.
 */
export function CommandKbd({ command }: { readonly command: string }) {
  const keybindings = useKeybindings();
  const shortcut = shortcutFor(keybindings, command);
  const caps = shortcut === null ? [] : keycapsFor(shortcut, detectModKey());
  return caps.length === 0 ? null : <Keycaps caps={caps} />;
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

/**
 * One chord as one keycap: `⌘⌥R` on macOS, `Ctrl+Alt+R` elsewhere. A cap per
 * key made a three-key chord three boxes, which reads as three shortcuts.
 */
export function Keycaps({ caps }: { readonly caps: ReadonlyArray<string> }) {
  return <Kbd>{caps.join(detectModKey() === "meta" ? "" : "+")}</Kbd>;
}

/**
 * Every chord bound to `commands`, one keycap group each; nothing when none is
 * bound. For a hint that names all the keys, such as a card's key line.
 */
export function CommandKeys({ commands }: { readonly commands: ReadonlyArray<string> }) {
  const chords = useCommandKeycaps(commands);
  if (chords.length === 0) {
    return null;
  }
  return (
    <>
      {chords.map((caps) => (
        <Keycaps key={caps.join("+")} caps={caps} />
      ))}
    </>
  );
}
