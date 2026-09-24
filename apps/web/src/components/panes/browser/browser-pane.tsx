/**
 * The thread's browser pane — the dock's Browser tab.
 *
 * - `in-app` (desktop): the pane is a toolbar over a `BrowserSlot`. The
 *   thread's tabs are `<webview>`s the browser host renders above the routes
 *   (`@/components/browser-host`), and the selected one is laid over the
 *   slot — so closing the pane, switching dock tab or thread, or visiting
 *   /settings hides a tab without destroying it, and the agent keeps driving
 *   it. The toolbar moves that webview itself; the server only hears about
 *   it, which is what bumps the human-control epoch. The host forwards the
 *   guests' own gestures and each tab's location.
 * - `owned-chromium` (the web renderer, no desktop): the pane renders the
 *   JPEG frame stream and forwards gestures and toolbar actions; the server
 *   replays them into its own headless Chromium.
 * - `disabled` (desktop with `OPENADE_REMOTE_DEBUG=0`): the agent has no
 *   browser, and the pane says so above the tabs a person can still browse.
 *
 * Nothing here creates a webview: with no tab the pane shows "No page open".
 * A tab appears on the agent's first call, a page's popup, an address typed
 * here, or `openInThreadBrowser`. A failed attach shows as an alert with
 * Retry — never as a silent switch to a headless browser.
 *
 * The atoms come from the one app runtime (`@/state/app-runtime`) — there is
 * a single socket to the server, and this pane is one of its subscribers.
 */
import * as React from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { BrowserHumanInput } from "@OpenAde/contracts/rpc";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@OpenAde/ui/components/alert";
import { Button } from "@OpenAde/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@OpenAde/ui/components/empty";
import { AsyncResult } from "effect/unstable/reactivity";

import { BrowserSlot } from "@/components/browser-host/browser-slot";
import { getTabView } from "@/components/browser-host/tab-views";
import { FOCUS_SURFACE } from "@/lib/keybinding-context";
import { getAppAtoms } from "@/state/app-runtime";
import {
  nextTabIdentity,
  openTab,
  selectedTab,
  useSetBrowserTabs,
  useThreadTabs,
} from "@/state/browser-tabs";
import { AddressBar } from "./address-bar";
import { FrameSurface } from "./frame-surface";
import { isAgentBrowserMissing } from "./install";
import { InstallPrompt } from "./install-prompt";
import { BROWSER_DISABLED_LABEL, browserModeLabel, frameFallback } from "./status";
import { AlertTriangle, Globe, InfoSquare, Refresh } from "@honeyicons/react";

/** What the pane itself will load into a webview: the web, nothing else. */
const WEB_URL = /^https?:\/\//i;

export interface BrowserPaneProps {
  readonly threadId: ThreadId;
}

/** What the slot shows while the thread has no tab. */
function NoPage() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Globe variant="bold" />
        </EmptyMedia>
        <EmptyTitle>No page open</EmptyTitle>
        <EmptyDescription>
          Enter an address above. The agent opens a tab here when it needs one.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A whole-surface message: the pane has no browser to show here. */
function NoBrowser({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Globe variant="bold" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The in-app browser's failure — the agent got the same message — with Retry. */
function AttachError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="px-2 pb-2">
      <Alert variant="destructive">
        <AlertTriangle variant="bold" />
        <AlertTitle>The agent could not use the browser</AlertTitle>
        <AlertDescription className="break-words">{message}</AlertDescription>
        <AlertAction>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            <Refresh variant="bold" data-icon="inline-start" />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

/** The kill switch on the desktop: the agent has no browser, the person still does. */
function DisabledNotice() {
  return (
    <div className="px-2 pb-2">
      <Alert>
        <InfoSquare variant="bold" />
        <AlertTitle>{BROWSER_DISABLED_LABEL}</AlertTitle>
        <AlertDescription>
          The agent&apos;s browser tools are off for this run. You can still browse here.
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function BrowserPane({ threadId }: BrowserPaneProps) {
  const atoms = getAppAtoms();
  const stateResult = useAtomValue(atoms.browserStateAtom(threadId));
  const state = AsyncResult.isSuccess(stateResult) ? stateResult.value : null;
  const sendInput = useAtomSet(atoms.sendBrowserInput, { mode: "promiseExit" });
  const hostsTabs = window.openade?.browserPane?.serveTabs !== undefined;
  const threadTabs = useThreadTabs(threadId);
  const setTabs = useSetBrowserTabs();
  const tab = selectedTab(threadTabs);

  const dispatch = React.useCallback(
    (input: BrowserHumanInput) => {
      void sendInput({ threadId, input });
    },
    [sendInput, threadId],
  );

  // A missing agent-browser is the one failure the pane can talk the user
  // through, so it takes the whole surface instead of a truncated chip.
  const missing =
    state !== null && state.status === "error" && isAgentBrowserMissing(state.message);
  // The desktop hosts the thread's tabs, whether or not the agent may use them.
  const inApp = !missing && hostsTabs && (state === null || state.mode !== "owned-chromium");
  const attachError =
    inApp && state !== null && state.status === "error" ? (state.message ?? "error") : null;
  const retry = React.useCallback(
    () => dispatch({ kind: "history", direction: "reload" }),
    [dispatch],
  );

  // In-app, the toolbar moves the selected tab's webview directly — or, with
  // no tab yet, opens one on the address typed — and the server only hears
  // about it.
  const onToolbar = React.useCallback(
    (input: BrowserHumanInput) => {
      if (inApp) {
        const view = tab === null ? null : getTabView(tab.tabId);
        if (input.kind === "navigate") {
          if (!WEB_URL.test(input.url)) return;
          if (view !== null) {
            // Every webview method throws until the guest's first `dom-ready`.
            void Promise.resolve()
              .then(() => view.loadURL(input.url))
              .catch(() => undefined);
          } else if (tab === null) {
            setTabs((current) =>
              openTab(current, threadId, {
                ...nextTabIdentity(),
                url: input.url,
                openedBy: "human",
                background: false,
              }),
            );
          }
        } else if (input.kind === "history" && view !== null) {
          try {
            if (input.direction === "back") view.goBack();
            else if (input.direction === "forward") view.goForward();
            else view.reload();
          } catch {
            // Not ready yet: there is no history to move through.
          }
        }
      }
      dispatch(input);
    },
    [inApp, tab, setTabs, threadId, dispatch],
  );

  const tabUrl = tab === null || !WEB_URL.test(tab.url) ? "" : tab.url;

  const modeLabel = state === null ? null : browserModeLabel(state.mode);

  return (
    // Focus anywhere in the pane — the address bar, its buttons — reads as
    // `browserFocus`, so the app's Mod+L and Mod+[ / Mod+] leave it alone.
    <div data-context={FOCUS_SURFACE.browser} className="flex h-full min-h-0 flex-col">
      <AddressBar state={state} url={inApp ? tabUrl : undefined} onAction={onToolbar} />
      {state?.mode === "owned-chromium" && modeLabel !== null ? (
        <p className="px-3 pb-1.5 type-micro text-muted-foreground">{modeLabel}</p>
      ) : null}
      {inApp && state?.mode === "disabled" ? <DisabledNotice /> : null}
      {attachError === null ? null : <AttachError message={attachError} onRetry={retry} />}
      {missing ? (
        <InstallPrompt mode={state.mode} onRetry={retry} />
      ) : inApp ? (
        <BrowserSlot threadId={threadId}>{tab === null ? <NoPage /> : null}</BrowserSlot>
      ) : state !== null && state.mode === "in-app" ? (
        // A plain browser tab on a desktop's server: the tabs live in the
        // desktop window, and there is no headless browser to fall back to.
        <NoBrowser
          title="The in-app browser shows in the OpenAde window"
          detail="The agent drives this thread's browser in the desktop app."
        />
      ) : state !== null && state.mode === "disabled" ? (
        <NoBrowser
          title={BROWSER_DISABLED_LABEL}
          detail="The agent's browser tools are off for this run."
        />
      ) : state !== null && state.status !== "stopped" ? (
        <FrameSurface state={state} onGesture={dispatch} />
      ) : (
        // A stopped session has no frame and nothing to forward input to, so
        // it gets this block rather than the frame surface's placeholder —
        // which used to read "starting…" while the chip above said "stopped".
        // The wording still comes from `frameFallback`, so the surface and the
        // frame stream cannot describe the same state differently.
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {state === null ? "connecting to the server…" : frameFallback(state)}
        </div>
      )}
    </div>
  );
}
