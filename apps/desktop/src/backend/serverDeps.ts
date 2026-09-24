/**
 * Electron-side dependencies for `ServerSupervisor`: how to spawn the server
 * (the bundled `main.cjs` under `ELECTRON_RUN_AS_NODE`, or the TypeScript entry
 * through the tsx loader in dev) and how to surface a repeated-crash failure.
 */
import { app, dialog } from "electron";

import { devServerEntry, packagedServerEntry } from "./serverArgs";
import { serverEnv, type BridgeForServer } from "./serverEnv";
import type { SpawnSpec } from "./ServerSupervisor";

// Bundled to cjs — `__dirname` is real at runtime.
declare const __dirname: string;

/**
 * The bundled server entry, or the TypeScript entry in dev, with the browser
 * bridge as it stands when the server is (re)spawned (`./serverEnv`).
 */
export const serverSpawnSpec = (bridge: BridgeForServer): SpawnSpec => {
  const env = serverEnv(process.env, { packaged: app.isPackaged, bridge });
  const entry = app.isPackaged
    ? packagedServerEntry(process.execPath, __dirname)
    : devServerEntry(process.execPath, __dirname);
  return { ...entry, env };
};

/** Surfaced after five consecutive failed attempts instead of spinning. */
export const showServerCrashDialog = (reason: string): void => {
  void dialog.showMessageBox({
    type: "error",
    title: "Poseidon server stopped",
    message: "The Poseidon server crashed repeatedly and will not restart.",
    detail: reason,
    buttons: ["OK"],
  });
};
