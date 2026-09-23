/**
 * The one place a pseudo-terminal is started. Everything above this file talks
 * to `PtyProcess`, our own narrow interface, never to the native module.
 *
 * The module is `@lydell/node-pty`: node-pty's own code with one prebuilt
 * N-API binary per platform, shipped as optional packages. N-API is what lets
 * one binary load under plain Node (tests, `pnpm dev`) and under the desktop
 * app's Electron binary run as Node, with no rebuild per ABI, and the prebuilt
 * Linux package is what keeps a checkout free of a C++ toolchain.
 *
 * It is loaded on the first spawn, not at boot, so a missing or broken binary
 * only makes opening a terminal fail as unavailable; the rest of the server
 * never notices.
 */
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

type NodePty = typeof import("@lydell/node-pty");
type NativePty = ReturnType<NodePty["spawn"]>;

/** The native module could not be loaded on this machine. */
export class PtyUnavailable extends Data.TaggedError("PtyUnavailable")<{
  readonly message: string;
}> {}

/** The module loaded, but starting this shell failed. */
export class PtySpawnFailed extends Data.TaggedError("PtySpawnFailed")<{
  readonly file: string;
  readonly cwd: string;
  readonly message: string;
}> {}

export interface PtyExit {
  readonly exitCode: number;
  /** The signal that ended the process, `null` when it exited on its own. */
  readonly signal: number | null;
}

/**
 * One running pseudo-terminal. Once the process has exited, `write`, `resize`
 * and `kill` do nothing: the pid may already belong to another process.
 */
export interface PtyProcess {
  readonly pid: number;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** `signal` defaults to SIGHUP, what a closing terminal sends. Ignored on Windows. */
  readonly kill: (signal?: string) => void;
  /** Returns the unsubscribe. */
  readonly onData: (listener: (data: string) => void) => () => void;
  /** Returns the unsubscribe. */
  readonly onExit: (listener: (exit: PtyExit) => void) => () => void;
}

export interface SpawnPtyOptions {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export const spawnPty = (
  options: SpawnPtyOptions,
): Effect.Effect<PtyProcess, PtyUnavailable | PtySpawnFailed> =>
  Effect.gen(function* () {
    const pty = yield* Effect.tryPromise({
      try: loadPty,
      catch: (cause) =>
        new PtyUnavailable({ message: `terminal support failed to load: ${describe(cause)}` }),
    });
    return yield* Effect.try({
      try: () =>
        wrap(
          pty.spawn(options.file, [...options.args], {
            name: options.env.TERM ?? "xterm-256color",
            cwd: options.cwd,
            env: { ...options.env },
            cols: options.cols,
            rows: options.rows,
          }),
        ),
      catch: (cause) =>
        new PtySpawnFailed({ file: options.file, cwd: options.cwd, message: describe(cause) }),
    });
  });

let loading: Promise<NodePty> | undefined;

/**
 * The module, loaded once. The package is CommonJS, so its API is on
 * `default` or on the namespace itself depending on who does the interop —
 * Node's ESM loader, vitest, or esbuild's CJS bundle. A failed load is not
 * cached, so a later open tries again.
 */
const loadPty = (): Promise<NodePty> => {
  loading ??= import("@lydell/node-pty")
    .then(async (mod) => {
      const pty = (mod as NodePty & { readonly default?: NodePty }).default ?? mod;
      if (typeof pty.spawn !== "function") throw new Error("the module has no spawn function");
      if (process.platform !== "win32") await ensureHelperExecutable();
      return pty;
    })
    .catch((cause: unknown) => {
      loading = undefined;
      throw cause;
    });
  return loading;
};

/**
 * On macOS and Linux node-pty starts the shell through a small `spawn-helper`
 * executable beside its binary. Copying the package or extracting an archive
 * can drop the helper's exec bit, and every spawn then fails with EACCES, so
 * put it back. Best effort: any failure here is left for the spawn to report.
 *
 * The helper is found from the loaded package's own location, taken from the
 * CommonJS module cache — which works whether this file runs as ESM source or
 * inside the server's CJS bundle, where `import.meta.url` is empty.
 */
const ensureHelperExecutable = async (): Promise<void> => {
  try {
    const suffix = nodePath.join("@lydell", "node-pty", "index.js");
    const cache = createRequire(process.execPath).cache;
    const entry = Object.keys(cache).find((key) => key.endsWith(suffix));
    if (entry === undefined) return;
    const target = `${process.platform}-${process.arch}`;
    const platformEntry = createRequire(entry).resolve(`@lydell/node-pty-${target}`);
    const helper = nodePath
      .join(nodePath.dirname(platformEntry), "..", "prebuilds", target, "spawn-helper")
      .replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
    const { mode } = await stat(helper);
    if ((mode & 0o111) !== 0o111) await chmod(helper, 0o755);
  } catch {
    // The spawn itself reports whatever is still wrong.
  }
};

const wrap = (native: NativePty): PtyProcess => {
  let exited = false;
  native.onExit(() => {
    exited = true;
  });
  return {
    pid: native.pid,
    write: (data) => {
      if (!exited) native.write(data);
    },
    resize: (cols, rows) => {
      if (exited) return;
      try {
        native.resize(cols, rows);
      } catch {
        // The pty closed between the check and the ioctl; the exit is on its way.
      }
    },
    kill: (signal) => {
      if (exited) return;
      try {
        if (process.platform === "win32") native.kill();
        else native.kill(signal);
      } catch {
        // Already gone.
      }
    },
    onData: (listener) => {
      const subscription = native.onData(listener);
      return () => subscription.dispose();
    },
    onExit: (listener) => {
      const subscription = native.onExit(({ exitCode, signal }) =>
        listener({ exitCode, signal: signal !== undefined && signal !== 0 ? signal : null }),
      );
      return () => subscription.dispose();
    },
  };
};

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
