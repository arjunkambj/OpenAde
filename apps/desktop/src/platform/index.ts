/**
 * Platform-facing setup that must run before `app.whenReady`: product name,
 * the Windows user-model id, and the Chromium switches the shell refuses.
 *
 * Chromium's remote-debugging port is never opened — the in-app browser goes
 * through the scoped bridge instead, and `./browserBridge` decides whether
 * that starts (docs/architecture.md, "The browser bridge").
 */
import { app } from "electron";

import { stripRemoteDebugging } from "./browserBridge";
import { appUserModelId, productName, resolveChannel } from "./channel";

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

  const removed = stripRemoteDebugging(app.commandLine);
  if (removed.length > 0) {
    console.warn(`[platform] ignored ${removed.map((name) => `--${name}`).join(", ")}`);
  }
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
