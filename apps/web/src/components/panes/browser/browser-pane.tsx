/**
 * The thread's browser pane — the dock's Browser tab.
 *
 * - Mode A (`cdp-attach`, desktop): a real `<webview>` shows the live page;
 *   the server attaches to it over CDP. Human gestures inside the guest come
 *   back through `window.openade.browserPane.onInput` and are forwarded as
 *   `browser.humanInput` — which is what interrupts an in-flight agent call.
 * - Mode B (`owned-chromium`, browser/dev or CDP-less desktop): the pane
 *   renders the JPEG frame stream and forwards gestures the same way; the
 *   server replays them into its own Chromium.
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

import { getAppAtoms, getHttpBase } from "@/state/app-runtime";
import { AddressBar } from "./address-bar";
import { FrameSurface } from "./frame-surface";
import { isAgentBrowserMissing } from "./install";
import { InstallPrompt } from "./install-prompt";
import { WebviewSurface } from "./webview-surface";

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

  // Mode A renders the webview even before the driver attaches — the guest
  // shows the attach marker, then whatever the agent navigates to. Owned
  // Chromium falls back to the frame stream.
  //
  // Without a resolved connection there is no marker url to load: a relative
  // one would pull the app's own SPA into the guest and break the driver's
  // target matching, so we wait for the socket instead.
  const httpBase = getHttpBase();
  const useWebview =
    !missing &&
    bridge !== undefined &&
    httpBase !== null &&
    (state === null || state.mode !== "owned-chromium");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AddressBar state={state} onAction={dispatch} />
      {missing ? (
        <InstallPrompt onRetry={() => dispatch({ kind: "history", direction: "reload" })} />
      ) : useWebview ? (
        <WebviewSurface
          threadId={threadId}
          attachUrl={`${httpBase}/browser/attach/${threadId}`}
          onLocation={onLocation}
        />
      ) : state !== null && state.status !== "stopped" ? (
        <FrameSurface state={state} onGesture={dispatch} />
      ) : (
        // A stopped session has no frame and nothing to forward input to, so
        // it gets this block rather than the frame surface's placeholder —
        // which used to read "starting…" while the chip above said "stopped".
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {httpBase === null
            ? "connecting to the server…"
            : "browser is stopped — it starts on the first agent call"}
        </div>
      )}
    </div>
  );
}
