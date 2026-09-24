/**
 * How to invoke the Poseidon server, packaged or from source.
 *
 * Kept free of `electron` so the argv can be asserted under plain node: the
 * dev form is the one that used to be wrong, and the failure it caused was
 * invisible from the desktop side.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A command plus argv; `serverDeps` adds the environment. */
export interface ServerEntry {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The bundled `out/server/main.cjs`. electron-builder asar-unpacks `out/server`
 * so the child can be spawned as a real file.
 */
export const packagedServerEntry = (command: string, mainDir: string): ServerEntry => ({
  command,
  args: [join(mainDir, "..", "server", "main.cjs").replace("app.asar", "app.asar.unpacked")],
});

/**
 * `node --import <tsx loader> apps/server/src/main.ts`.
 *
 * The loader has to be registered *in this process*. The `tsx` CLI instead
 * re-execs node as its own child, and the grandchild does not inherit the
 * supervisor's fd 3: the server's handshake `writeSync(3, …)` fails with ENXIO
 * and falls back to stdout, the supervisor never leaves "starting", and the
 * SIGKILL it eventually sends reaches only the wrapper — the real server is
 * re-parented to PID 1 and keeps the sqlite file and its port. `--import`
 * keeps the server as the direct child, so fd 3 survives.
 *
 * Watch mode is not lost: `scripts/dev.mjs` esbuild-watches the same entry and
 * restarts Electron, which restarts the supervised server.
 */
export const devServerEntry = (command: string, mainDir: string): ServerEntry => {
  const serverRoot = join(mainDir, "..", "..", "..", "server");
  const require = createRequire(join(serverRoot, "package.json"));
  const loader = pathToFileURL(require.resolve("tsx")).href;
  return { command, args: ["--import", loader, join(serverRoot, "src", "main.ts")] };
};
