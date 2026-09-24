/**
 * One pane tab: the Electron `<webview>` that IS the page, in its thread's
 * `persist:thread-<id>` partition.
 *
 * The host renders it once and moves it only by its CSS position. It is never
 * reparented and never re-keyed — either re-creates the guest, which the agent
 * sees as `tab_gone` and a new target — and its `src` is the url it was
 * opened with, never the live one, so a re-render never navigates it.
 *
 * Hidden, it keeps a real size inside the viewport and is only transparent,
 * click-through and beneath the app (see `./host-geometry`).
 *
 * `allowpopups` lets `window.open` reach the shell's window-open handler,
 * which never opens a native window: it asks the host for a tab instead.
 */
import * as React from "react";

import { cn } from "@/lib/utils";
import { faviconOf, type BrowserTab, type TabPatch } from "@/state/browser-tabs";

import type { Rect } from "./host-geometry";
import { forgetTabView, registerTabView, tabReady, type WebviewElement } from "./tab-views";

export interface TabWebviewProps {
  readonly threadId: string;
  readonly tab: BrowserTab;
  readonly rect: Rect;
  readonly visible: boolean;
  /** What the guest reported, for the tab's entry in the tabs atom. */
  readonly onPatch: (threadId: string, tabId: string, patch: TabPatch) => void;
}

/**
 * The page and its history. Every webview method throws until the guest's
 * first `dom-ready` — `did-attach` and the first `did-navigate` come before
 * it — so an early event reports nothing rather than failing.
 */
const history = (view: WebviewElement): TabPatch => {
  try {
    return {
      url: view.getURL(),
      title: view.getTitle(),
      canGoBack: view.canGoBack(),
      canGoForward: view.canGoForward(),
      zoomLevel: view.getZoomLevel(),
    };
  } catch {
    return {};
  }
};

function TabWebviewImpl({ threadId, tab, rect, visible, onPatch }: TabWebviewProps) {
  const viewRef = React.useRef<WebviewElement | null>(null);
  const { tabId } = tab;

  // A layout effect: the listeners must be on before the guest's first event.
  React.useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    registerTabView(tabId, view);
    const patch = (next: TabPatch) => onPatch(threadId, tabId, next);
    let wcId: number | null = null;
    // The guest's id is readable from its first `dom-ready`, not `did-attach`.
    const onReady = () => {
      const id = view.getWebContentsId();
      if (id !== wcId) {
        wcId = id;
        patch({ wcId: id, ...history(view) });
        tabReady(tabId, id);
      }
    };
    const onNavigate = () => patch(history(view));
    // A new document drops the old page's icon; its own arrives after.
    const onDocument = () => patch({ ...history(view), favicon: null });
    const onFavicon = (event: Event) =>
      patch({ favicon: faviconOf((event as Event & { favicons?: unknown }).favicons) });
    const onStart = () => patch({ loading: true });
    const onStop = () => patch({ loading: false, ...history(view) });
    view.addEventListener("dom-ready", onReady);
    view.addEventListener("did-navigate", onDocument);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-favicon-updated", onFavicon);
    view.addEventListener("page-title-updated", onNavigate);
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    return () => {
      view.removeEventListener("dom-ready", onReady);
      view.removeEventListener("did-navigate", onDocument);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-favicon-updated", onFavicon);
      view.removeEventListener("page-title-updated", onNavigate);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      forgetTabView(tabId);
    };
  }, [threadId, tabId, onPatch]);

  // Electron reads `partition` once, before the guest attaches, and
  // `allowpopups` by presence — so both go through as plain attributes, set
  // when the element is created and never changed.
  const attributes: Readonly<Record<string, string>> = {
    src: tab.initialUrl,
    partition: `persist:thread-${threadId}`,
    allowpopups: "",
  };
  return (
    <webview
      ref={(element: HTMLElement | null) => {
        viewRef.current = element as WebviewElement | null;
      }}
      {...attributes}
      data-browser-tab={tabId}
      aria-hidden={!visible}
      className={cn(
        "fixed top-(--browser-tab-y) left-(--browser-tab-x) h-(--browser-tab-height) w-(--browser-tab-width)",
        visible ? "z-30" : "pointer-events-none -z-10 opacity-0",
      )}
      style={
        {
          "--browser-tab-x": `${rect.x}px`,
          "--browser-tab-y": `${rect.y}px`,
          "--browser-tab-width": `${rect.width}px`,
          "--browser-tab-height": `${rect.height}px`,
        } as React.CSSProperties
      }
    />
  );
}

export const TabWebview = React.memo(TabWebviewImpl);
