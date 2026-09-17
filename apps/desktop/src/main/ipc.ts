/**
 * ipcMain handlers backing the preload bridge: connection info, server-state
 * fan-out, validated external opens, and directory picking.
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";

import type { ServerSupervisor, ServerState } from "../backend/ServerSupervisor";

export function registerIpc(supervisor: ServerSupervisor) {
  ipcMain.handle("openade:connection", () => supervisor.connection);
  ipcMain.handle("openade:open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("openade:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  supervisor.on("state", (state: ServerState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("openade:server-state", state);
    }
  });
}
