/**
 * The `will-attach-webview` policy for the browser pane (spec section 13).
 *
 * Two jobs, and the first one is what the guard used to get wrong: Electron's
 * renderer side builds the attach `params` from a map that always holds every
 * webview attribute, so `preload`, `nodeintegration`, `allowpopups` and
 * `webpreferences` are *always* own keys — `""` or `false` when the tag did not
 * set them. Testing for key presence therefore refused every attach, including
 * the pane's own clean `<webview partition="persist:thread-1" src="https://…">`.
 * The policy judges values instead.
 *
 * The second job is the one the spec actually asks for: the handler overwrites
 * renderer-supplied preferences rather than only refusing bad ones, so a guest
 * that somehow reaches this point still runs sandboxed, context-isolated and
 * without Node or a preload script.
 *
 * Kept free of `electron` imports so the whole policy is unit-testable.
 */

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
}

/** Only the browser pane's own per-thread partitions may attach. */
const PANE_PARTITION = /^persist:thread-[A-Za-z0-9_-]+$/;

/**
 * Attributes that grant capabilities the pane never opts into. Electron sends
 * them on every attach, so `""`, `false` and `"false"` all mean "not set".
 */
const ESCALATION_ATTRIBUTES = {
  preload: "",
  webpreferences: "",
  nodeintegration: false,
  allowpopups: false,
} as const;

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

  // Reset the escalation attributes to the values Electron sends when the tag
  // never set them, so nothing downstream reads a renderer-supplied one.
  for (const [attribute, unset] of Object.entries(ESCALATION_ATTRIBUTES)) {
    if (!isUnset(params[attribute])) {
      params[attribute] = unset;
    }
  }

  const partition = params["partition"];
  if (typeof partition !== "string" || !PANE_PARTITION.test(partition)) {
    return `partition ${JSON.stringify(partition)} is not a browser-pane partition`;
  }

  const src = params["src"];
  if (typeof src !== "string" || !/^https?:\/\//.test(src)) {
    return `src ${JSON.stringify(src)} is not http(s)`;
  }

  return null;
};
