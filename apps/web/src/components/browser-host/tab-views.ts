/**
 * The live `<webview>` element behind each pane tab, by tab id.
 *
 * The pane's toolbar moves the selected tab's webview directly (in-app, the
 * server never navigates for the person), and the host answers the shell's
 * `create` request with the new guest's `webContents` id only once the
 * webview can say it — both need the element, which React owns. The tab's
 * `TabWebview` registers it here and reports the id at the guest's first
 * `dom-ready`, the earliest a webview answers `getWebContentsId`.
 */

/**
 * The Electron webview tag, narrowed to what the pane and host touch. React's
 * own types declare `<webview>` against `HTMLWebViewElement`, which has none
 * of these methods.
 */
export interface WebviewElement extends HTMLElement {
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

const views = new Map<string, WebviewElement>();
const attached = new Map<string, number>();
const waiters = new Map<
  string,
  Array<{ resolve: (wcId: number) => void; reject: (error: Error) => void }>
>();

export const registerTabView = (tabId: string, view: WebviewElement): void => {
  views.set(tabId, view);
};

/** The tab's guest is ready and its id is known. */
export const tabReady = (tabId: string, wcId: number): void => {
  attached.set(tabId, wcId);
  for (const waiter of waiters.get(tabId) ?? []) waiter.resolve(wcId);
  waiters.delete(tabId);
};

/** The tab's webview left the DOM: anything still waiting for it fails. */
export const forgetTabView = (tabId: string): void => {
  views.delete(tabId);
  attached.delete(tabId);
  for (const waiter of waiters.get(tabId) ?? []) {
    waiter.reject(new Error("the tab was closed before it opened"));
  }
  waiters.delete(tabId);
};

export const getTabView = (tabId: string): WebviewElement | null => views.get(tabId) ?? null;

/** Resolves the tab's guest `webContents` id once its webview can tell it. */
export const whenTabReady = (tabId: string): Promise<number> => {
  const now = attached.get(tabId);
  if (now !== undefined) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    waiters.set(tabId, [...(waiters.get(tabId) ?? []), { resolve, reject }]);
  });
};
