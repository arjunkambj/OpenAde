/**
 * Electron-side dependencies for `ServerSupervisor`: how to spawn the server
 * (the bundled `main.cjs` under `ELECTRON_RUN_AS_NODE`, or the TypeScript entry
 * through the tsx loader in dev) and how to surface a repeated-crash failure.
 */
import { app, dialog } from "electron";

import { cdpPort } from "../platform";
import { devServerEntry, packagedServerEntry } from "./serverArgs";
import type { SpawnSpec } from "./ServerSupervisor";

// Bundled to cjs — `__dirname` is real at runtime.
declare const __dirname: string;

/** The bundled server entry, or the TypeScript entry in dev. */
export const serverSpawnSpec = (): SpawnSpec => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPENADE_DEV: app.isPackaged ? "" : "1",
    // The loopback CDP endpoint the browser pane's webview is reachable on
    // (the driver's `cdp-attach` mode). Empty when remote debugging is
    // disabled.
    OPENADE_CDP_PORT: cdpPort === null ? "" : String(cdpPort),
  };
  const entry = app.isPackaged
    ? packagedServerEntry(process.execPath, __dirname)
    : devServerEntry(process.execPath, __dirname);
  return { ...entry, env };
};

/** Surfaced after five consecutive failed attempts instead of spinning. */
export const showServerCrashDialog = (reason: string): void => {
  void dialog.showMessageBox({
    type: "error",
    title: "OpenAde server stopped",
    message: "The OpenAde server crashed repeatedly and will not restart.",
    detail: reason,
    buttons: ["OK"],
  });
};
