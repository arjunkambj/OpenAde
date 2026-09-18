/**
 * App lifecycle glue: single instance, protocol privileges, the server
 * supervisor, and window creation. Everything else lives in the modules
 * alongside (`protocol`, `window`, `ipc`, `updater`, and `../platform`).
 */
import { BrowserWindow, app, protocol } from "electron";

import { ServerSupervisor } from "../backend/ServerSupervisor";
import { serverSpawnSpec, showServerCrashDialog } from "../backend/serverDeps";
import { registerIpc } from "./ipc";
import { applyPlatformDefaults } from "../platform";
import { quitsWhenAllWindowsClosed } from "../platform/lifecycle";
import { APP_SCHEME, registerAppProtocol } from "./protocol";
import { makeQuitHandler } from "./quit";
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

/** How long a quit waits for the server child before exiting without it. */
const QUIT_DEADLINE_MS = 15_000;

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

  app.on(
    "before-quit",
    makeQuitHandler({
      stopServer: () => supervisor.stop(),
      onWaiting: () => {
        for (const win of BrowserWindow.getAllWindows()) win.hide();
      },
      exit: () => app.exit(),
      // The server closes sessions one by one under their own timeouts; the
      // supervisor's own SIGKILL lands well inside this.
      deadlineMs: QUIT_DEADLINE_MS,
    }),
  );
  app.on("window-all-closed", () => {
    if (quitsWhenAllWindowsClosed(process.platform)) app.quit();
  });
}
