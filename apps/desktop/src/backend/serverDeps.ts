/**
 * Electron-side dependencies for `ServerSupervisor`: how to spawn the server
 * (the bundled `main.cjs` under `ELECTRON_RUN_AS_NODE`, or `tsx watch` in dev)
 * and how to surface a repeated-crash failure.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { app, dialog } from "electron";

import { cdpPort } from "../main/platform";
import type { SpawnSpec } from "./ServerSupervisor";

// Bundled to cjs — `__dirname` is real at runtime.
declare const __dirname: string;
const here = dirname(__dirname);

/** The bundled server entry, or the tsx entry in dev. */
export const serverSpawnSpec = (): SpawnSpec => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPENADE_DEV: app.isPackaged ? "" : "1",
    // The loopback CDP endpoint the browser pane's webview is reachable on
    // (W6 mode A). Empty when remote debugging is disabled.
    OPENADE_CDP_PORT: cdpPort === null ? "" : String(cdpPort),
  };
  if (app.isPackaged) {
    // The bundle is asar-unpacked so the child can spawn it directly.
    const entry = join(__dirname, "..", "server", "main.cjs").replace(
      "app.asar",
      "app.asar.unpacked",
    );
    return {
      command: process.execPath,
      args: [entry],
      env,
    };
  }
  const require = createRequire(join(here, "../../server/package.json"));
  const tsx = require.resolve("tsx/cli");
  return {
    command: process.execPath,
    args: [tsx, "watch", join(here, "../../server/src/main.ts")],
    env,
  };
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
