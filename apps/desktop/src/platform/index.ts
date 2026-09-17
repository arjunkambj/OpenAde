/**
 * Platform-facing setup that must run before `app.whenReady`: product name,
 * the Windows user-model id, and the loopback CDP endpoint the browser pane
 * attaches through (W6 mode A — docs/decisions/w6-browser-mode.md).
 *
 * Remote debugging is off by default and never leaves `127.0.0.1`; it turns on
 * for `browserPane: true` in the shell's preferences file (`./preferences`),
 * and `./cdp` documents the environment overrides on top of that.
 */
import { app } from "electron";

import { randomCdpPort, resolveCdpPort } from "./cdp";
import { readDesktopPreferences } from "./preferences";

/** The remote-debugging port Chromium bound, or `null` when it opened none. */
export let cdpPort: number | null = null;

/** Keeps userData/cache tied to the product rather than the package name. */
export function applyPlatformDefaults() {
  app.setName("OpenAde");
  if (process.platform === "win32") {
    app.setAppUserModelId("dev.openade.OpenAde.desktop");
  }

  const preferences = readDesktopPreferences();
  cdpPort = resolveCdpPort(process.env, randomCdpPort, preferences.browserPane);
  if (cdpPort === null) return;
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
}

export const titleBarStyle = (): "hiddenInset" | "default" =>
  process.platform === "darwin" ? "hiddenInset" : "default";
