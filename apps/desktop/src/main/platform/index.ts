/**
 * Platform-facing setup that must run before `app.whenReady`: product name,
 * the Windows user-model id, and the opt-in remote-debugging port (loopback
 * only, behind OPENADE_REMOTE_DEBUG=1).
 */
import { app } from "electron";

/** Keeps userData/cache tied to the product rather than the package name. */
export function applyPlatformDefaults() {
  app.setName("OpenAde");
  if (process.platform === "win32") {
    app.setAppUserModelId("dev.openade.OpenAde.desktop");
  }
  if (process.env.OPENADE_REMOTE_DEBUG === "1") {
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }
}

export const titleBarStyle = (): "hiddenInset" | "default" =>
  process.platform === "darwin" ? "hiddenInset" : "default";
