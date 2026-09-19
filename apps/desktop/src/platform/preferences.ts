/**
 * The handful of preferences the shell itself has to know before Electron is
 * ready, read from `<config dir>/desktop.json`.
 *
 * The server owns the settings document, but it lives in SQLite behind an RPC
 * the renderer dials *after* the window exists — far too late for switches that
 * decide Chromium command-line flags. So the shell keeps its own small JSON
 * file next to the database, resolved through the same `OPENADE_HOME`-aware
 * config dir, and reads it synchronously at startup.
 *
 * Everything here is fail-open to the safe value: a missing file, unreadable
 * file, or malformed JSON means "no preferences set", never a crash before the
 * app can report one.
 */
import * as NodeFS from "node:fs";

import { configPath } from "@OpenAde/shared/paths";

export interface DesktopPreferences {
  /**
   * Run the browser pane as the in-app `<webview>`, which the server drives
   * over CDP. Off by default: it makes Chromium open a loopback
   * remote-debugging port, which anything else running as this user can
   * drive. Off, the server falls back to agent-browser's own Chromium, which
   * needs no such port.
   */
  readonly browserPane: boolean;
}

const DEFAULTS: DesktopPreferences = { browserPane: false };

/** Absolute path of the shell's own preferences file. */
export const preferencesPath = (env: NodeJS.ProcessEnv = process.env): string =>
  configPath(["desktop.json"], env);

const readBoolean = (
  document: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean => {
  const value = document[key];
  return typeof value === "boolean" ? value : fallback;
};

/** Reads the preferences file, falling back to the defaults on anything unusable. */
export const readDesktopPreferences = (
  path: string = preferencesPath(),
  readFile: (at: string) => string = (at) => NodeFS.readFileSync(at, "utf8"),
): DesktopPreferences => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    return DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return DEFAULTS;
  }
  const document = parsed as Record<string, unknown>;
  return { browserPane: readBoolean(document, "browserPane", DEFAULTS.browserPane) };
};
