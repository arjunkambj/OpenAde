/**
 * Which executable "cmd" actually means, and how to spell the call.
 *
 * Resolution order: the configured `binaryPath`,
 * then `cmd` on `PATH` — plus the global bin directories a GUI process never
 * inherits — then `npx -y command-code@latest` so a machine without the global
 * install still works.
 *
 * This lived inside `probe.ts`, which meant the answer was reported to the UI
 * and then thrown away: every turn spawned the literal string `"cmd"` and every
 * `cmd mcp` call did the same, both resolved against the server process's own
 * PATH. A packaged .app launched from Finder inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which does not contain `/opt/homebrew/bin`
 * — so the connectors page probed green through `extraBinDirs()` and the first
 * message failed with ENOENT. The npx fallback was worse: the probe reported
 * ready and the spawn still asked for a binary that was never there.
 *
 * So the resolution lives here, both callers use it, and `prefixArgs` is what
 * carries the npx package spec through to the spawn.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** What the npx fallback installs when there is no `cmd` on the machine. */
export const NPX_PACKAGE = "command-code@latest";

export interface ResolvedBinary {
  readonly command: string;
  /** Prepended args — the npx fallback's package spec, else empty. */
  readonly prefixArgs: ReadonlyArray<string>;
  /** What `binaryPath` reports on the probe: the configured path, or the display name. */
  readonly display: string;
}

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Extra directories `cmd` commonly lands in when PATH was not inherited. */
export const extraBinDirs = (): Array<string> => {
  const home = NodeOS.homedir();
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    NodePath.join(home, ".bun", "bin"),
    NodePath.join(home, ".local", "share", "pnpm"),
    NodePath.join(home, ".npm-global", "bin"),
  ];
};

const findOnPath = (
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  extraDirs: ReadonlyArray<string> = extraBinDirs(),
): string | null => {
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * The binary a probe or a turn should actually spawn, or `null` when the
 * machine has neither `cmd` nor `npx`.
 */
export const resolveBinary = (
  config: { readonly binaryPath?: string | undefined },
  env: Readonly<Record<string, string | undefined>>,
  /** The global bin dirs to search after PATH; a test narrows it to nothing. */
  extraDirs: ReadonlyArray<string> = extraBinDirs(),
): ResolvedBinary | null => {
  if (config.binaryPath !== undefined && config.binaryPath !== "") {
    return { command: config.binaryPath, prefixArgs: [], display: config.binaryPath };
  }
  const onPath = findOnPath("cmd", env, extraDirs);
  if (onPath !== null) {
    return { command: onPath, prefixArgs: [], display: onPath };
  }
  const npx = findOnPath("npx", env, extraDirs);
  if (npx !== null) {
    return {
      command: npx,
      prefixArgs: ["-y", NPX_PACKAGE],
      display: `npx ${NPX_PACKAGE}`,
    };
  }
  return null;
};

/**
 * The resolution a session falls back on when nothing resolves: the bare name,
 * against whatever PATH the server inherited. It is what the connector used to
 * do unconditionally — keeping it as the last resort means a machine this
 * module cannot read (a locked-down home, an unusual install) still gets the
 * old behaviour rather than a session that refuses to start.
 */
export const BARE_CMD: ResolvedBinary = { command: "cmd", prefixArgs: [], display: "cmd" };

/** The resolution for a session, never null — `BARE_CMD` when nothing resolved. */
export const resolveForSession = (
  config: { readonly binaryPath?: string | undefined },
  env: Readonly<Record<string, string | undefined>>,
  extraDirs: ReadonlyArray<string> = extraBinDirs(),
): ResolvedBinary => resolveBinary(config, env, extraDirs) ?? BARE_CMD;
