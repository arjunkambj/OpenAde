/**
 * The `will-attach-webview` policy for the browser pane.
 *
 * Two jobs, and the first one is what the guard used to get wrong: Electron's
 * renderer side builds the attach `params` from a map that always holds every
 * webview attribute, so `preload`, `nodeintegration`, `allowpopups` and
 * `webpreferences` are *always* own keys — `""` or `false` when the tag did not
 * set them. Testing for key presence therefore refused every attach, including
 * the pane's own clean `<webview partition="persist:thread-1" src="https://…">`.
 * The policy judges values instead.
 *
 * The second job is the one that matters for the guest: the handler overwrites
 * renderer-supplied preferences rather than only refusing bad ones, so a guest
 * that somehow reaches this point still runs sandboxed, context-isolated and
 * without Node or a preload script.
 *
 * Popups are the one capability the pane opts into. A pane tab carries
 * `allowpopups` so that `window.open` reaches the guest's
 * `setWindowOpenHandler`, which `./ipc.ts` installs on every webview guest the
 * moment it is created: it always denies the native window and turns an
 * http(s) popup into a new pane tab in the same thread (`./browser/guests.ts`).
 * Without the attribute a popup is dropped before any handler sees it.
 * The popup loses `window.opener`, since it is a fresh guest rather than a
 * child window.
 *
 * Which object to write to matters. Electron's guest-view manager derives the
 * `webPreferences` it will build the guest from *before* it emits
 * `will-attach-webview` — `plugins: params.plugins`,
 * `disablePopups: !params.allowpopups`, `webSecurity: !params.disablewebsecurity`
 * — and then creates the guest from that object, not from `params`. Rewriting an
 * attribute back to its unset value therefore changes nothing the guest sees, so
 * every capability the policy denies is pinned on `preferences`; the `params`
 * reset stays as defence in depth for anything that reads them later.
 *
 * Kept free of `electron` imports so the whole policy is unit-testable.
 */
import { threadIdOfPartition } from "./browser/guests";

/** The subset of `Electron.WebPreferences` the policy pins for a guest. */
export interface GuestPreferences {
  preload?: string;
  nodeIntegration?: boolean;
  nodeIntegrationInWorker?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  experimentalFeatures?: boolean;
  webviewTag?: boolean;
  enableBlinkFeatures?: string;
  /** Pepper plugins. Electron derives this straight from the `plugins` attribute. */
  plugins?: boolean;
  /**
   * Electron's internal inverse of `allowpopups`, derived from the attribute.
   * The policy leaves it alone: every guest's window-open handler denies the
   * native window, so a popup can only ever become a pane tab.
   */
  disablePopups?: boolean;
}

/**
 * Attributes that grant capabilities the pane never opts into. Electron sends
 * them on every attach, so `""`, `false` and `"false"` all mean "not set".
 */
const ESCALATION_ATTRIBUTES = {
  preload: "",
  webpreferences: "",
  nodeintegration: false,
  plugins: false,
} as const;

/** What a pane tab may start on: a web page, or a blank tab the agent opened. */
const isPaneSrc = (src: unknown): boolean =>
  typeof src === "string" && (/^https?:\/\//.test(src) || src === "about:blank");

const isUnset = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  value === false ||
  value === "false" ||
  value === "0";

/**
 * Pins the guest's preferences and decides whether the attach may proceed.
 *
 * Returns `null` when the attach is allowed, or the reason to refuse it. The
 * preferences are rewritten either way — refusing is the caller's job and a
 * missed `preventDefault` must not leave a privileged guest behind.
 */
export const applyWebviewAttachPolicy = (
  preferences: GuestPreferences,
  params: Record<string, unknown>,
): string | null => {
  delete preferences.preload;
  delete preferences.enableBlinkFeatures;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  preferences.experimentalFeatures = false;
  // A guest may not nest another webview.
  preferences.webviewTag = false;
  // Already derived from `params.plugins` by the time this handler runs, so
  // resetting the attribute below would come too late.
  preferences.plugins = false;

  // Reset the escalation attributes to the values Electron sends when the tag
  // never set them, so nothing downstream reads a renderer-supplied one.
  for (const [attribute, unset] of Object.entries(ESCALATION_ATTRIBUTES)) {
    if (!isUnset(params[attribute])) {
      params[attribute] = unset;
    }
  }

  const partition = params["partition"];
  if (threadIdOfPartition(partition) === null) {
    return `partition ${JSON.stringify(partition)} is not a browser-pane partition`;
  }

  const src = params["src"];
  if (!isPaneSrc(src)) {
    return `src ${JSON.stringify(src)} is not http(s) or about:blank`;
  }

  return null;
};
