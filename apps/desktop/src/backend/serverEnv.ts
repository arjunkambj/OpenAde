/**
 * The environment the server child is spawned with.
 *
 * The shell's own environment, plus `ELECTRON_RUN_AS_NODE`, `OPENADE_DEV`, and
 * the browser bridge (`@OpenAde/shared/browserBridge`): its origin and the
 * per-launch key, or `disabled`. The bridge variables carry the
 * `OPENADE_SERVER_` prefix because the harness spawn passes `OPENADE_*`
 * through and drops only that prefix. Whatever the shell itself inherited
 * under those names never reaches the server.
 *
 * Electron-free, so the env is unit-tested; `./serverDeps` feeds it the real
 * `process.env`.
 */
import { BRIDGE_DISABLED, BRIDGE_ENV, BRIDGE_KEY_ENV } from "@OpenAde/shared/browserBridge";

/** What the shell knows about the bridge by the time it spawns the server. */
export type BridgeForServer =
  | { readonly kind: "enabled"; readonly origin: string; readonly launchKey: string }
  | { readonly kind: "disabled" };

const INHERITED_BRIDGE = new Set([BRIDGE_ENV, BRIDGE_KEY_ENV]);

export const serverEnv = (
  base: NodeJS.ProcessEnv,
  options: { readonly packaged: boolean; readonly bridge: BridgeForServer },
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!INHERITED_BRIDGE.has(name)) env[name] = value;
  }
  env["ELECTRON_RUN_AS_NODE"] = "1";
  env["OPENADE_DEV"] = options.packaged ? "" : "1";
  if (options.bridge.kind === "enabled") {
    env[BRIDGE_ENV] = options.bridge.origin;
    env[BRIDGE_KEY_ENV] = options.bridge.launchKey;
  } else {
    env[BRIDGE_ENV] = BRIDGE_DISABLED;
  }
  return env;
};
