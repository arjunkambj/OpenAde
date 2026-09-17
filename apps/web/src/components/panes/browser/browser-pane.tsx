/**
 * The thread's browser pane.
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
 */
import * as React from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { BrowserHumanInput } from "@OpenAde/contracts/rpc";
import { BrowserHumanInput as BrowserHumanInputSchema } from "@OpenAde/contracts/rpc";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";

import { useAppRuntime, type AppRuntime } from "@/lib/runtime";
import { AddressBar } from "./address-bar";
import { FrameSurface } from "./frame-surface";
import { WebviewSurface } from "./webview-surface";

export interface BrowserPaneProps {
  readonly threadId: ThreadId;
}

export function BrowserPane({ threadId }: BrowserPaneProps) {
  const app = useAppRuntime();
  if (app === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        connecting…
      </div>
    );
  }
  return <BrowserPaneInner app={app} threadId={threadId} />;
}

function BrowserPaneInner({ app, threadId }: { app: AppRuntime; threadId: ThreadId }) {
  const stateResult = useAtomValue(app.atoms.browserStateAtom(threadId));
  const state = AsyncResult.isSuccess(stateResult) ? stateResult.value : null;
  const sendInput = useAtomSet(app.atoms.sendBrowserInput, { mode: "promiseExit" });
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

  // Mode A renders the webview even before the driver attaches — the guest
  // shows the attach marker, then whatever the agent navigates to. Owned
  // Chromium falls back to the frame stream.
  const useWebview = bridge !== undefined && (state === null || state.mode !== "owned-chromium");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AddressBar state={state} onAction={dispatch} />
      {useWebview ? (
        <WebviewSurface
          threadId={threadId}
          attachUrl={`${app.httpBase}/browser/attach/${threadId}`}
          onLocation={onLocation}
        />
      ) : state !== null ? (
        <FrameSurface state={state} onGesture={dispatch} />
      ) : (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          browser is stopped — it starts on the first agent call
        </div>
      )}
    </div>
  );
}
