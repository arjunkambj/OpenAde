/**
 * Platform-facing setup that must run before `app.whenReady`: product name,
 * the Windows user-model id, and the loopback CDP endpoint the browser pane
 * attaches through (W6 mode A — docs/decisions/w6-browser-mode.md).
 *
 * Remote debugging stays on `127.0.0.1` only. It is on by default at a random
 * high port; `OPENADE_REMOTE_DEBUG=0` disables it (the server falls back to
 * agent-browser's owned Chromium), `OPENADE_REMOTE_DEBUG=1` keeps the old
 * fixed 9222 for manual DevTools, and `OPENADE_CDP_PORT=<n>` pins the port
 * handed to the server as `OPENADE_CDP_PORT`.
 */
import { app } from "electron";

/** The remote-debugging port Chromium bound, when enabled. */
export let cdpPort: number | null = null;

/** Keeps userData/cache tied to the product rather than the package name. */
export function applyPlatformDefaults() {
  app.setName("OpenAde");
  if (process.platform === "win32") {
    app.setAppUserModelId("dev.openade.OpenAde.desktop");
  }

  const remoteDebug = process.env.OPENADE_REMOTE_DEBUG ?? "";
  if (remoteDebug === "0") return;

  const pinned = Number.parseInt(process.env.OPENADE_CDP_PORT ?? "", 10);
  const explicit = Number.parseInt(remoteDebug, 10);
  cdpPort =
    Number.isInteger(pinned) && pinned > 1024
      ? pinned
      : remoteDebug === "1" || remoteDebug === "true"
        ? 9222
        : Number.isInteger(explicit) && explicit > 1024
          ? explicit
          : 20_000 + Math.floor(Math.random() * 40_000);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
}

export const titleBarStyle = (): "hiddenInset" | "default" =>
  process.platform === "darwin" ? "hiddenInset" : "default";
