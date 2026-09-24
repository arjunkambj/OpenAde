/**
 * The in-app pane's chrome above the page: the address bar, the tab strip under it,
 * the element picker and screenshot (`./page-actions`) and the "more" menu, all acting on the thread's tabs — the webviews the
 * browser host renders — directly (`./tab-actions`).
 *
 * It also owns the pane's keys. `browser.focusUrl`, `browser.reload`,
 * `browser.back` and `browser.forward` answer here, bound with
 * `when: browserFocus`, which holds while focus is anywhere in the pane (its
 * root carries `data-context="browser"`). A key pressed inside the page never reaches the window; the shell
 * matches those for it and the browser host runs them
 * (`@/components/browser-host/use-guest-keys`).
 */
import * as React from "react";

import type { BrowserHumanInput, BrowserState } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { getTabView } from "@/components/browser-host/tab-views";
import { useKeybindingCommand } from "@/lib/shortcuts";
import {
  closeTab,
  nextTabIdentity,
  openTab,
  patchTab,
  selectedTab,
  selectTab,
  useSetBrowserTabs,
  useThreadTabs,
} from "@/state/browser-tabs";
import { AddressBar } from "./address-bar";
import { isPaneUrl } from "./address";
import { MoreMenu } from "./more-menu";
import { PageActions } from "./page-actions";
import { TabStrip } from "./tab-strip";
import type { SuggestionSource } from "./use-suggestions";
import {
  BROWSER_COMMANDS,
  historyInput,
  loadInTab,
  moveTab,
  type HistoryDirection,
} from "./tab-actions";
import { zoomPercent } from "./zoom";

const WEB_URL = /^https?:\/\//i;

/** With no tab there is no history to move through. */
const NO_TAB = { canGoBack: false, canGoForward: false, loading: false } as const;

export interface InAppToolbarProps {
  readonly threadId: string;
  readonly state: BrowserState | null;
  /** Tells the server about a person's gesture. */
  readonly dispatch: (input: BrowserHumanInput) => void;
  readonly suggest: SuggestionSource;
}

export function InAppToolbar({ threadId, state, dispatch, suggest }: InAppToolbarProps) {
  const threadTabs = useThreadTabs(threadId);
  const setTabs = useSetBrowserTabs();
  const tab = selectedTab(threadTabs);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Looked up when used: the host registers a new tab's webview after this renders.
  const currentView = () => (tab === null ? null : getTabView(tab.tabId));

  const move = (direction: HistoryDirection) => {
    const view = currentView();
    if (view !== null) moveTab(view, direction);
    dispatch(historyInput(direction));
  };

  const openHumanTab = (url: string) =>
    setTabs((current) =>
      openTab(current, threadId, {
        ...nextTabIdentity(),
        url,
        openedBy: "human",
        background: false,
      }),
    );

  const onAction = (input: BrowserHumanInput) => {
    if (input.kind === "history") {
      move(input.direction);
      return;
    }
    if (input.kind === "navigate") {
      if (!isPaneUrl(input.url)) return;
      // With no tab yet, the address typed opens one.
      const view = currentView();
      if (view !== null) loadInTab(view, input.url);
      else if (tab === null) openHumanTab(input.url);
    }
    dispatch(input);
  };

  const focusAddress = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const newTab = () => {
    openHumanTab("about:blank");
    // After the render that selects it, so the field shows the blank tab.
    requestAnimationFrame(focusAddress);
  };

  const zoom = (level: number) => {
    const view = currentView();
    if (tab === null || view === null) return;
    try {
      view.setZoomLevel(level);
    } catch {
      return;
    }
    setTabs((current) => patchTab(current, threadId, tab.tabId, { zoomLevel: level }));
  };

  useKeybindingCommand(BROWSER_COMMANDS.focusUrl, focusAddress);
  useKeybindingCommand(BROWSER_COMMANDS.reload, () => move("reload"));
  useKeybindingCommand(BROWSER_COMMANDS.back, () => move("back"));
  useKeybindingCommand(BROWSER_COMMANDS.forward, () => move("forward"));

  const level = tab?.zoomLevel ?? 0;

  return (
    <div>
      <AddressBar
        state={state}
        url={tab === null || !WEB_URL.test(tab.url) ? "" : tab.url}
        nav={tab ?? NO_TAB}
        onAction={onAction}
        inputRef={inputRef}
        suggest={suggest}
      >
        {level === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={<Button type="button" variant="ghost" size="xs" onClick={() => zoom(0)} />}
            >
              {zoomPercent(level)}%
            </TooltipTrigger>
            <TooltipContent>Reset zoom</TooltipContent>
          </Tooltip>
        )}
        <PageActions threadId={threadId} tab={tab} />
        <MoreMenu tab={tab} onZoom={zoom} />
      </AddressBar>
      {threadTabs.tabs.length === 0 ? null : (
        <TabStrip
          tabs={threadTabs}
          onSelect={(tabId) => setTabs((current) => selectTab(current, threadId, tabId))}
          onClose={(tabId) => setTabs((current) => closeTab(current, threadId, tabId))}
          onNew={newTab}
        />
      )}
    </div>
  );
}
