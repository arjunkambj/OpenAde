/**
 * The thread's browser pane — the dock's Browser tab.
 *
 * - `in-app` (desktop): a real `<webview>` shows the live page, and the
 *   agent drives that same webview through the shell's browser bridge. Human
 *   gestures inside the guest come back through
 *   `window.openade.browserPane.onInput` and are forwarded as
 *   `browser.humanInput` — which is what interrupts an in-flight agent call.
 *   The toolbar moves the webview itself; the server only hears about it.
 * - `owned-chromium` (the web renderer, no desktop): the pane renders the
 *   JPEG frame stream and forwards gestures and toolbar actions; the server
 *   replays them into its own headless Chromium.
 * - `disabled` (desktop with `OPENADE_REMOTE_DEBUG=0`): no browser; the pane
 *   says so.
 *
 * Toolbar actions are human gestures (`history`, `navigate`); observed
 * navigation in the guest is synced as passive `location` so the agent's own
 * navigations don't masquerade as a takeover.
 *
 * The atoms come from the one app runtime (`@/state/app-runtime`) — there is
 * a single socket to the server, and this pane is one of its subscribers.
 */
import * as React from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { BrowserHumanInput } from "@OpenAde/contracts/rpc";
import { BrowserHumanInput as BrowserHumanInputSchema } from "@OpenAde/contracts/rpc";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";

import { FOCUS_SURFACE } from "@/lib/keybinding-context";
import { getAppAtoms } from "@/state/app-runtime";
import { AddressBar } from "./address-bar";
import { FrameSurface } from "./frame-surface";
import { isAgentBrowserMissing } from "./install";
import { InstallPrompt } from "./install-prompt";
import { frameFallback } from "./status";
import { WebviewSurface, type WebviewElement } from "./webview-surface";

/** What the pane itself will load into its webview: the web, nothing else. */
const WEB_URL = /^https?:\/\//i;

export interface BrowserPaneProps {
  readonly threadId: ThreadId;
}

export function BrowserPane({ threadId }: BrowserPaneProps) {
  const atoms = getAppAtoms();
  const stateResult = useAtomValue(atoms.browserStateAtom(threadId));
  const state = AsyncResult.isSuccess(stateResult) ? stateResult.value : null;
  const sendInput = useAtomSet(atoms.sendBrowserInput, { mode: "promiseExit" });
  const bridge = window.openade?.browserPane;

  const dispatch = React.useCallback(
    (input: BrowserHumanInput) => {
      void sendInput({ threadId, input });
    },
    [sendInput, threadId],
  );

  // Guest gestures (main's before-input-event relay) → browser.humanInput.
  // The contract schema is the boundary check: anything that doesn't parse
  // is dropped, never forwarded.
  React.useEffect(() => {
    if (bridge === undefined) return;
    return bridge.onInput(({ threadId: id, input }) => {
      if (id !== threadId) return;
      const parsed = Schema.decodeUnknownExit(BrowserHumanInputSchema)(input);
      if (parsed._tag === "Success") {
        dispatch(parsed.value);
      }
    });
  }, [bridge, threadId, dispatch]);

  const onLocation = React.useCallback(
    (url: string, title?: string) => {
      dispatch({ kind: "location", url, ...(title !== undefined && { title }) });
    },
    [dispatch],
  );

  // A missing agent-browser is the one failure the pane can talk the user
  // through, so it takes the whole surface instead of a truncated chip.
  const missing =
    state !== null && state.status === "error" && isAgentBrowserMissing(state.message);

  // In-app renders the webview even before the agent's first call — it sits
  // on about:blank until someone navigates it. Owned Chromium falls back to
  // the frame stream.
  const useWebview =
    !missing && bridge !== undefined && (state === null || state.mode === "in-app");
  const viewRef = React.useRef<WebviewElement | null>(null);

  // In-app, the toolbar moves the webview directly; the server only hears
  // about it, which is what bumps the human-control epoch.
  const onToolbar = React.useCallback(
    (input: BrowserHumanInput) => {
      const view = viewRef.current;
      if (useWebview && view !== null) {
        if (input.kind === "navigate") {
          if (!WEB_URL.test(input.url)) return;
          void view.loadURL(input.url).catch(() => undefined);
        } else if (input.kind === "history") {
          if (input.direction === "back") view.goBack();
          else if (input.direction === "forward") view.goForward();
          else view.reload();
        }
      }
      dispatch(input);
    },
    [useWebview, dispatch],
  );

  return (
    // Focus anywhere in the pane — the address bar, its buttons — reads as
    // `browserFocus`, so the app's Mod+L and Mod+[ / Mod+] leave it alone.
    <div data-context={FOCUS_SURFACE.browser} className="flex h-full min-h-0 flex-col">
      <AddressBar state={state} onAction={onToolbar} />
      {missing ? (
        <InstallPrompt onRetry={() => dispatch({ kind: "history", direction: "reload" })} />
      ) : useWebview ? (
        // `key` is load-bearing: the guest's `partition` cannot be changed
        // once it is attached (Electron logs an error and reverts the
        // attribute), while `src` can — so switching threads with the dock
        // open used to navigate thread B's page inside thread A's persisted
        // partition, cookies and all. Keying on the thread destroys the guest
        // and builds a new one in the right partition instead.
        <WebviewSurface
          key={threadId}
          threadId={threadId}
          viewRef={viewRef}
          onLocation={onLocation}
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
