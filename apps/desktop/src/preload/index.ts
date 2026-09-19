/**
 * The only surface the renderer sees: connection info, server-state events,
 * validated external opens, directory picking, and the browser-pane bridge.
 * `data-desktop` attributes keep `packages/ui` styles keyed to the shell.
 *
 * The bridge itself lives in `./bridge`, which knows nothing about `electron`
 * so it can be unit-tested against a fake channel; this module only supplies
 * the real `ipcRenderer` and exposes the result.
 */
import { contextBridge, ipcRenderer } from "electron";

import {
  desktopAttributes,
  FULLSCREEN_ATTRIBUTE,
  FULLSCREEN_CHANNEL,
} from "../platform/attributes";

import { makeOpenAdeBridge } from "./bridge";

contextBridge.exposeInMainWorld("openade", makeOpenAdeBridge(ipcRenderer));

function markDesktop(): boolean {
  const root = document.documentElement;
  if (!root) return false;
  for (const attribute of desktopAttributes(process.platform)) {
    root.setAttribute(attribute, "");
  }
  return true;
}

if (!markDesktop()) {
  window.addEventListener("DOMContentLoaded", markDesktop, { once: true });
}

ipcRenderer.on(FULLSCREEN_CHANNEL, (_event, fullScreen: unknown) => {
  document.documentElement?.toggleAttribute(FULLSCREEN_ATTRIBUTE, fullScreen === true);
});
