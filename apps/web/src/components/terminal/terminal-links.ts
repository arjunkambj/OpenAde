/**
 * Which clicks on a link the terminal printed are asked to open it.
 *
 * Only a mod-click (⌘ on macOS, Ctrl elsewhere) opens anything: a plain click
 * in a terminal is for placing the selection, and must never navigate. And
 * only http(s) links open — the destination is the thread's browser pane, and
 * a `file:` or custom-scheme link has no business there.
 */

import type { ModKey } from "@poseidon/client-runtime/keybindings";

/** The URL to open for this click on `uri`, or null to leave it alone. */
export const linkToOpen = (
  uri: string,
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  modKey: ModKey,
): string | null => {
  if (!(modKey === "meta" ? event.metaKey : event.ctrlKey)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
};
