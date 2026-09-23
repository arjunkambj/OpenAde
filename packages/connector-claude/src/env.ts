/**
 * The environment a Claude Code child runs with — default deny.
 *
 * The SDK's `env` option replaces the child's environment outright, so what
 * the child sees is exactly what this returns: a short list of names a CLI
 * legitimately needs, the `LC_*` locales, and `CLAUDE_CONFIG_DIR` when the
 * instance names an account of its own. Nothing else is inherited.
 *
 * Default deny matters more for this harness than for any other, because
 * OpenAde can itself be launched from inside a Claude Code session. Such a
 * process carries `CLAUDECODE`, a few dozen `CLAUDE_CODE_*` variables —
 * among them the parent session's id, its OAuth scopes and a messaging socket
 * and token — plus `CLAUDE_AGENT_SDK_*` and `ANTHROPIC_BASE_URL`. Handed on,
 * they would make our child believe it is a subprocess of that session, talk
 * to the parent's socket, or send its API traffic wherever the parent's base
 * URL points. They are dropped by name as well as by omission, so no later
 * change to the allowlist can let one through.
 *
 * `HOME` is inherited and never set here. The CLI finds its macOS keychain
 * entry — the subscription login — under `HOME`, so moving it signs the
 * child out; a second account goes through `CLAUDE_CONFIG_DIR` instead.
 */

import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Exact names the child keeps. The second row is what a CLI needs to reach the
 * network and git in the real world: the ssh agent for git-over-ssh inside
 * shell commands, and the proxy and CA variables its own API calls depend on.
 */
const BASE_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

/** Prefixes that pass: the locale variables. */
const PASS_PREFIXES = ["LC_"];

/**
 * What never reaches the child, whatever the allowlist says: a parent Claude
 * Code session's variables, the SDK's, other credentials for the API, and our
 * own server's internals.
 */
const DROP_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK_", "ANTHROPIC_", "OPENADE_SERVER_"];
const DROP_NAMES = new Set(["CLAUDECODE", "CLAUDE_CONFIG_DIR"]);

const isDropped = (name: string): boolean =>
  DROP_NAMES.has(name) || DROP_PREFIXES.some((prefix) => name.startsWith(prefix));

const isAllowed = (name: string): boolean =>
  !isDropped(name) &&
  (BASE_ENV.has(name) || PASS_PREFIXES.some((prefix) => name.startsWith(prefix)));

/** `~` and `~/…` against the user's home; anything else resolved as given. */
export const expandHome = (path: string, home: string = NodeOS.homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? NodePath.join(home, path.slice(2))
      : NodePath.resolve(path);

/**
 * The child's environment: the allowlisted inherited variables, then
 * `CLAUDE_CONFIG_DIR` from the instance's config. An inherited
 * `CLAUDE_CONFIG_DIR` is dropped with the rest — which account a session uses
 * is the instance's setting, not whatever shell OpenAde was started from.
 */
export const childEnv = (
  inherited: Readonly<Record<string, string | undefined>>,
  config: { readonly configDir?: string | undefined },
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowed(name)) {
      out[name] = value;
    }
  }
  if (config.configDir !== undefined && config.configDir !== "") {
    out.CLAUDE_CONFIG_DIR = expandHome(config.configDir, inherited.HOME ?? NodeOS.homedir());
  }
  return out;
};
