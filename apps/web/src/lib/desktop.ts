/**
 * Thin helpers over the desktop preload bridge. Every call is optional-chained
 * off `window.openade`, so the same code runs in a plain browser tab — the
 * caller decides what "absent" means (a hidden button, a manual input).
 */

/** The native directory picker, or `null` in the browser / on cancel. */
export const pickDirectory = async (): Promise<string | null> =>
  (await window.openade?.pickDirectory?.()) ?? null;

/** Open a URL in the system browser; falls back to a new tab on the web. */
export const openExternal = (url: string): void => {
  const bridge = window.openade?.openExternal;
  if (bridge === undefined) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void bridge(url);
};
