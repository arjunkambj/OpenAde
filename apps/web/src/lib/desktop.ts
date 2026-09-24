/**
 * Thin helpers over the desktop preload bridge. Every call is optional-chained
 * off `window.poseidon`, so the same code runs in a plain browser tab — the
 * caller decides what "absent" means (a hidden button, a manual input).
 */

/**
 * Whether the shell offers a native directory dialog. Only the desktop does, so
 * everywhere else the renderer opens its own picker over `fs.browse` — which is
 * the same answer for a browser tab today and a remote client later. Read at
 * click time rather than at mount: the bridge is on `window` from the first
 * paint under Electron, and nothing else can make it appear or vanish.
 */
export const hasNativePicker = (): boolean => window.poseidon?.pickDirectory !== undefined;

/** The native directory picker, or `null` in the browser / on cancel. */
export const pickDirectory = async (): Promise<string | null> =>
  (await window.poseidon?.pickDirectory?.()) ?? null;

/** Open a URL in the system browser; falls back to a new tab on the web. */
export const openExternal = (url: string): void => {
  const bridge = window.poseidon?.openExternal;
  if (bridge === undefined) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void bridge(url);
};
