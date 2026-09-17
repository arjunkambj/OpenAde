/**
 * App lifecycle glue: single instance, protocol privileges, the server
 * supervisor, and window creation. Everything else lives in the modules
 * alongside (`protocol`, `window`, `platform`, `ipc`, `updater`).
 */
import { BrowserWindow, app, protocol } from "electron";

import { ServerSupervisor } from "../backend/ServerSupervisor";
import { serverSpawnSpec, showServerCrashDialog } from "../backend/serverDeps";
import { registerIpc } from "./ipc";
import { applyPlatformDefaults } from "./platform";
import { APP_SCHEME, registerAppProtocol } from "./protocol";
import { checkForUpdates } from "./updater";
import { createWindow } from "./window";

applyPlatformDefaults();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const focusExistingWindow = () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win === undefined) return;
  if (win.isMinimized()) win.restore();
  win.focus();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);

  const supervisor = new ServerSupervisor({
    spec: serverSpawnSpec,
    onRepeatedFailure: showServerCrashDialog,
  });

  void app.whenReady().then(async () => {
    registerAppProtocol();
    registerIpc(supervisor);
    supervisor.start();
    checkForUpdates();
    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });

  app.on("before-quit", () => supervisor.stop());
  app.on("window-all-closed", () => app.quit());
}
