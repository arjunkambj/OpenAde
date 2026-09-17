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
 *
 * An empty table falls back to the contract's defaults. A settings row that
 * has never been seeded reads as `[]`, and taking that literally would leave
 * the app with no shortcuts at all — no command palette, no interrupt — which
 * is never what "no keybindings configured" should mean.
 */

import { useAtomValue } from "@effect/atom-react";
import { detectModKey, resolveKeybinding } from "@OpenAde/client-runtime/keybindings";
import { DEFAULT_KEYBINDINGS } from "@OpenAde/contracts/settings";
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
  const served = AsyncResult.isSuccess(result) ? result.value : [];
  const keybindings = served.length > 0 ? served : DEFAULT_KEYBINDINGS;

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
