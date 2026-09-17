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

const MISSING_PREFIX = "agent-browser is not installed";

export const isAgentBrowserMissing = (message: string | undefined): boolean =>
  message !== undefined && message.trim().toLowerCase().startsWith(MISSING_PREFIX);

/** What the user has to run, in order. */
export const INSTALL_COMMANDS: ReadonlyArray<{ command: string; note: string }> = [
  { command: "npm install -g agent-browser", note: "installs the tool" },
  { command: "agent-browser install", note: "downloads the browser it drives" },
];
