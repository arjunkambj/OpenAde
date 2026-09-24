/**
 * The pane's keys while a page has focus.
 *
 * A key pressed inside a pane webview goes to the guest and never reaches
 * this window, so the one keybinding listener (`@/lib/shortcuts`) cannot see
 * it. Instead the host hands the shell the `browser.*` chords that apply in
 * the pane (`guestChordsFor`), re-sent whenever the table changes; the shell
 * matches them in the guest's `before-input-event`, swallows the key and
 * relays the command with the guest's `webContents` id
 * (`apps/desktop/src/main/browser/guestChords.ts`). That also keeps the
 * default menu's `Cmd+R` from reloading the whole window from inside a page.
 *
 * Here a relayed history command moves the tab it came from — whether or not
 * its pane is on screen — and tells the server, as the toolbar does; the rest
 * (`browser.focusAddress`) goes to whichever surface answers it.
 */
import * as React from "react";

import { detectModKey } from "@OpenAde/client-runtime/keybindings";

import { COMMAND_DIRECTIONS, historyInput, moveTab } from "@/components/panes/browser/tab-actions";
import { guestChordsFor } from "@/lib/keybindings";
import { useKeybindingDispatch, useKeybindings } from "@/lib/shortcuts";
import { findByWcId, type BrowserTabsState } from "@/state/browser-tabs";

import { getTabView } from "./tab-views";
import { useSendInput } from "./use-host-bridge";

type PaneBridge = NonNullable<NonNullable<Window["openade"]>["browserPane"]>;

export const useGuestKeys = (bridge: PaneBridge, state: BrowserTabsState) => {
  const keybindings = useKeybindings();
  const dispatch = useKeybindingDispatch();
  const send = useSendInput();
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    void bridge.setChords?.(guestChordsFor(keybindings, detectModKey())).catch((error: unknown) => {
      console.warn(`[browser] could not hand the shell the pane's keys: ${String(error)}`);
    });
  }, [bridge, keybindings]);

  React.useEffect(
    () =>
      bridge.onCommand?.(({ wcId, command }) => {
        const found = findByWcId(stateRef.current, wcId);
        if (found === null) return;
        const direction = COMMAND_DIRECTIONS[command];
        if (direction === undefined) {
          if (command.startsWith("browser.")) dispatch(command);
          return;
        }
        const view = getTabView(found.tab.tabId);
        if (view !== null) moveTab(view, direction);
        send(found.threadId, historyInput(direction));
      }),
    [bridge, dispatch, send],
  );
};
