/**
 * The in-app surface: the Electron `<webview>` that IS the page. It runs in
 * the thread's `persist:thread-*` partition and starts on `about:blank`; the
 * shell's browser bridge exposes it to the agent's CDP session as one of the
 * thread's tabs, and the human sees everything the agent does live.
 *
 * Navigation and title changes are reported upward as passive `location`
 * inputs — they synchronize our state but do NOT claim human control (the
 * human's real gestures arrive through `window.openade.browserPane.onInput`,
 * from the shell's per-guest input relay).
 *
 * The toolbar moves this webview itself through `viewRef`: in-app, the server
 * never navigates the pane for the human.
 *
 * `allowpopups` lets `window.open` reach the shell's window-open handler,
 * which never opens a native window: it asks for a pane tab instead.
 *
 * Mount it with `key={threadId}`. Electron refuses a `partition` change once
 * the guest is attached, so reusing one element across threads keeps the first
 * thread's session while `src` moves on — the per-thread isolation this is
 * built around, gone after the first thread switch.
 */
import * as React from "react";

/**
 * The Electron webview tag, narrowed to what the pane touches. React's own
 * types declare `<webview>` against `HTMLWebViewElement`; the Electron-only
 * attributes (`partition`, `allowpopups`) go through a spread so they don't
 * fight that declaration.
 */
export interface WebviewElement extends HTMLElement {
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

const BLANK = "about:blank";

export interface WebviewSurfaceProps {
  readonly threadId: string;
  /** The live element, for the toolbar's navigation. */
  readonly viewRef: React.RefObject<WebviewElement | null>;
  /** Passive navigation sync → `{kind: "location"}` input. */
  readonly onLocation: (url: string, title?: string) => void;
}

export function WebviewSurface({ threadId, viewRef, onLocation }: WebviewSurfaceProps) {
  React.useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const report = () => {
      const url = view.getURL();
      if (url !== "" && url !== BLANK) {
        onLocation(url, view.getTitle());
      }
    };
    view.addEventListener("did-navigate", report);
    view.addEventListener("did-navigate-in-page", report);
    view.addEventListener("page-title-updated", report);
    return () => {
      view.removeEventListener("did-navigate", report);
      view.removeEventListener("did-navigate-in-page", report);
      view.removeEventListener("page-title-updated", report);
    };
  }, [viewRef, onLocation]);

  // Electron reads `allowpopups` by presence, so it goes through as a plain
  // attribute rather than React's typed boolean.
  const webviewProps: Readonly<Record<string, string>> = {
    src: BLANK,
    partition: `persist:thread-${threadId}`,
    allowpopups: "",
    className: "block min-h-0 flex-1",
  };
  return <webview ref={viewRef} {...webviewProps} />;
}
