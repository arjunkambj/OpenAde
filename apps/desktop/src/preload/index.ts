/**
 * The only surface the renderer sees: connection info, server-state events,
 * validated external opens, directory picking, and a browser-pane bridge stub
 * that W6 fleshes out. `data-desktop` attributes keep `packages/ui` styles
 * keyed to the shell.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

export interface ServerState {
  readonly status: "starting" | "ready" | "restarting" | "failed";
}

const openade = {
  getConnection: (): Promise<ServerConnection | null> => ipcRenderer.invoke("openade:connection"),
  onServerState: (callback: (state: ServerState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ServerState) => callback(state);
    ipcRenderer.on("openade:server-state", listener);
    return () => ipcRenderer.removeListener("openade:server-state", listener);
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("openade:open-external", url),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("openade:pick-directory"),
  /**
   * Browser-pane bridge (W6 mode A): `attach` registers this window as the
   * host of the thread's `persist:thread-*` webview guest; `onInput` then
   * delivers every real pointer/keyboard/wheel gesture the guest sees —
   * already shaped like `BrowserHumanInput` — which the pane forwards as a
   * `browser.humanInput` call so the server can mark human control.
   */
  browserPane: {
    attach: (threadId: string): Promise<void> =>
      ipcRenderer.invoke("openade:browser-attach", threadId),
    detach: (threadId: string): Promise<void> =>
      ipcRenderer.invoke("openade:browser-detach", threadId),
    onInput: (callback: (payload: { threadId: string; input: unknown }) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { threadId: string; input: unknown },
      ) => callback(payload);
      ipcRenderer.on("openade:browser-input", listener);
      return () => ipcRenderer.removeListener("openade:browser-input", listener);
    },
  },
};

contextBridge.exposeInMainWorld("openade", openade);

function markDesktop(): boolean {
  const root = document.documentElement;
  if (!root) return false;
  root.setAttribute("data-desktop", "");
  if (process.platform === "darwin") {
    root.setAttribute("data-desktop-mac", "");
  }
  return true;
}

if (!markDesktop()) {
  window.addEventListener("DOMContentLoaded", markDesktop, { once: true });
}
