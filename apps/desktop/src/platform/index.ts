/**
 * Platform-facing setup that must run before `app.whenReady`: product name,
 * the Windows user-model id, and the loopback CDP endpoint the browser pane
 * attaches through (the driver's `cdp-attach` mode; docs/architecture.md, "The
 * MCP gateway and the browser").
 *
 * Remote debugging is off by default and never leaves `127.0.0.1`; it turns on
 * for `browserPane: true` in the shell's preferences file (`./preferences`),
 * and `./cdp` documents the environment overrides on top of that.
 */
import { app } from "electron";

import { randomCdpPort, resolveCdpPort } from "./cdp";
import { appUserModelId, productName, resolveChannel } from "./channel";
import { readDesktopPreferences } from "./preferences";

/** The remote-debugging port Chromium bound, or `null` when it opened none. */
export let cdpPort: number | null = null;

/**
 * Keeps userData/cache tied to the product rather than the package name, and
 * keeps both identities on the channel this build was packaged as — canary and
 * stable must not share a userData directory or a taskbar group.
 */
export function applyPlatformDefaults() {
  const channel = resolveChannel(process.env.OPENADE_CHANNEL);
  app.setName(productName(channel));
  if (process.platform === "win32") {
    app.setAppUserModelId(appUserModelId(channel));
  }

  const preferences = readDesktopPreferences();
  cdpPort = resolveCdpPort(process.env, randomCdpPort, preferences.browserPane);
  if (cdpPort === null) return;
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
}

export const titleBarStyle = (): "hidden" | "default" =>
  process.platform === "darwin" ? "hidden" : "default";

/**
 * Where macOS draws the traffic lights. The renderer's chrome row is
 * `--chrome-height` (3.25rem = 52px) tall and reserves
 * `--traffic-lights-width` (5rem) for them. A top of 19px lines the lights'
 * centres up with the row's icons, which sit a point above the row's middle —
 * measured on screen, not derived, so re-measure if the row changes.
 */
export const trafficLightPosition = (): { x: number; y: number } | undefined =>
  process.platform === "darwin" ? { x: 18, y: 19 } : undefined;
