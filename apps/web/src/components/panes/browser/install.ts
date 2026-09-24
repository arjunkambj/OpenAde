/**
 * "The browser tool is not installed" as something the pane can act on.
 *
 * The server reports a missing `agent-browser` as an ordinary
 * `BrowserState.status: "error"` with the install sentence in `message`. That
 * sentence truncates into nothing useful in the toolbar chip, so the pane
 * recognises this one error and shows the commands instead — the opening
 * clause is the contract (`AGENT_BROWSER_MISSING_MESSAGE` in
 * `apps/server/src/browser/agentBrowser.ts`).
 */

import type { BrowserState } from "@poseidon/contracts/rpc";

const MISSING_PREFIX = "agent-browser is not installed";

export const isAgentBrowserMissing = (message: string | undefined): boolean =>
  message !== undefined && message.trim().toLowerCase().startsWith(MISSING_PREFIX);

export interface InstallCommand {
  readonly command: string;
  readonly note: string;
}

const INSTALL_CLI: InstallCommand = {
  command: "npm install -g agent-browser",
  note: "installs the tool",
};

const DOWNLOAD_CHROME: InstallCommand = {
  command: "agent-browser install",
  note: "downloads the browser it drives",
};

/**
 * What the user has to run, in order. In-app, agent-browser drives the pane's
 * own webviews, so the CLI is all it needs; only the web renderer's headless
 * browser needs the Chrome that `agent-browser install` downloads.
 */
export const installCommands = (mode: BrowserState["mode"]): ReadonlyArray<InstallCommand> =>
  mode === "owned-chromium" ? [INSTALL_CLI, DOWNLOAD_CHROME] : [INSTALL_CLI];
