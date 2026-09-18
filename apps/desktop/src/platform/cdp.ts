/**
 * Whether Chromium opens a remote-debugging port, and which one.
 *
 * The port is on loopback and open only when the browser pane is enabled. It
 * is an attach surface — anything else running as this user can drive the
 * renderer, read thread content and the `persist:thread-*` partitions — so it
 * is off unless something explicitly asks for it. With no port the server
 * falls back to agent-browser's owned Chromium (the driver's `owned-chromium`
 * mode), which needs no CDP endpoint at all.
 *
 * Opt-ins, in precedence order:
 *  - `OPENADE_REMOTE_DEBUG=0` — never, whatever else is set.
 *  - `OPENADE_CDP_PORT=<port>` — pane on, pinned to that port.
 *  - `OPENADE_BROWSER_PANE=1`, or `browserPane: true` in the shell's own
 *    preferences file (`./preferences`) — pane on, random high port. The file
 *    is the product-facing switch; the variable is the one-off override.
 *  - `OPENADE_REMOTE_DEBUG=1` — 9222, for attaching DevTools by hand.
 *  - `OPENADE_REMOTE_DEBUG=<port>` — that port.
 */

const MIN_PORT = 1024;

const parsePort = (raw: string | undefined): number | null => {
  const port = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(port) && port > MIN_PORT && port <= 65_535 ? port : null;
};

const isTrue = (raw: string | undefined): boolean => raw === "1" || raw === "true";

/** A random high port, so two installs do not fight over one. */
export const randomCdpPort = (): number => 20_000 + Math.floor(Math.random() * 40_000);

/**
 * `null` means "do not open a remote-debugging port". `browserPane` is the
 * persisted setting from `./preferences`; it ORs with `OPENADE_BROWSER_PANE`
 * and still loses to the `OPENADE_REMOTE_DEBUG=0` kill switch.
 */
export const resolveCdpPort = (
  env: NodeJS.ProcessEnv,
  randomPort: () => number = randomCdpPort,
  browserPane = false,
): number | null => {
  const remoteDebug = env["OPENADE_REMOTE_DEBUG"];
  if (remoteDebug === "0" || remoteDebug === "false") return null;

  const pinned = parsePort(env["OPENADE_CDP_PORT"]);
  if (pinned !== null) return pinned;

  if (browserPane || isTrue(env["OPENADE_BROWSER_PANE"])) return randomPort();

  if (isTrue(remoteDebug)) return 9222;
  return parsePort(remoteDebug);
};
