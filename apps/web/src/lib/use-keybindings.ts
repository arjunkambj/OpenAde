/**
 * The global keybinding dispatch. One window-level listener resolves each
 * keydown against the server-owned table (`keybindingsAtom`) through the
 * client-runtime matcher, then calls the command handler the caller wired.
 *
 * The listener runs in bubble phase so focused controls get first refusal:
 * the composer's trigger menu stops Escape's propagation, and an interaction
 * card's capture-phase listener settles the key before it ever reaches here.
 *
 * Context flags feed `when` clauses — `composerFocus` is derived from the
 * active element's `data-context`, everything else comes from the caller
 * (`threadRunning`, `planPending`, …). Unknown commands resolve and are then
 * ignored, so a server default with no handler yet is inert, not an error.
 */

import { useAtomValue } from "@effect/atom-react";
import { detectModKey, resolveKeybinding } from "@OpenAde/client-runtime/keybindings";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";

const focusedContext = (target: EventTarget | null): string | undefined =>
  target instanceof HTMLElement
    ? (target.closest("[data-context]")?.getAttribute("data-context") ?? undefined)
    : undefined;

export function useGlobalKeybindings(
  commands: Readonly<Record<string, () => void>>,
  flags?: Readonly<Record<string, boolean | string>>,
): void {
  const { keybindingsAtom } = useClientRuntime();
  const result = useAtomValue(keybindingsAtom);
  const keybindings = AsyncResult.isSuccess(result) ? result.value : [];

  // Refs keep the listener stable across re-renders and flag churn.
  const commandsRef = React.useRef(commands);
  commandsRef.current = commands;
  const flagsRef = React.useRef(flags ?? {});
  flagsRef.current = flags ?? {};
  const keybindingsRef = React.useRef(keybindings);
  keybindingsRef.current = keybindings;

  React.useEffect(() => {
    const modKey = detectModKey();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) {
        return;
      }
      const context = (name: string): boolean | string | undefined => {
        if (name === "composerFocus") {
          return focusedContext(event.target) === "composer";
        }
        return flagsRef.current[name];
      };
      const binding = resolveKeybinding(keybindingsRef.current, event, context, modKey);
      const handler = binding === null ? undefined : commandsRef.current[binding.command];
      if (handler === undefined) {
        return;
      }
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
