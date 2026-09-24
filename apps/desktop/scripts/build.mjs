import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

import {
  PTY_PACKAGE,
  packageRootOf,
  packagedArches,
  patchHelperPath,
  ptyPackagesFor,
} from "./native-modules.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = join(root, "out");
export const rendererDist = join(root, "..", "web", "dist");
export const rendererOut = join(outDir, "renderer");
const serverModulesOut = join(outDir, "server", "node_modules");

/**
 * `import.meta.url` for a bundle esbuild turns into CommonJS, where it would
 * otherwise be undefined. The Claude Agent SDK calls
 * `createRequire(import.meta.url)` when its module loads, so a server bundle
 * without this throws before it starts. Only the server gets it: the preload
 * runs sandboxed, where `require("node:url")` does not exist.
 */
export const IMPORT_META_URL = {
  define: { "import.meta.url": "__importMetaUrl" },
  // The directive goes first again: a banner ahead of esbuild's own "use strict"
  // would demote it to an ordinary string and the bundle to sloppy mode.
  banner: {
    js: '"use strict"; const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
};

/** @param {{ watch?: boolean, channel?: "stable" | "canary" }} [options] */
export function bundleOptions({ watch = false, channel = "stable" } = {}) {
  return [
    { entry: "src/main/index.ts", outfile: "out/main/index.cjs" },
    { entry: "src/preload/index.ts", outfile: "out/preload/index.cjs" },
    // The server ships inside the app; spawned under ELECTRON_RUN_AS_NODE.
    { entry: "../server/src/main.ts", outfile: "out/server/main.cjs", importMetaUrl: true },
  ].map(({ entry, outfile, importMetaUrl = false }) => ({
    entryPoints: [join(root, entry)],
    outfile: join(root, outfile),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // The pty module is a native binary; `copyNativeModules` ships it beside
    // the bundle instead.
    external: ["electron", PTY_PACKAGE],
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
      // `src/platform/channel.ts` derives the product name and the Windows
      // app-user-model id from this, so it has to be the channel
      // electron-builder is packaging with.
      "process.env.POSEIDON_CHANNEL": JSON.stringify(channel),
      ...(importMetaUrl ? IMPORT_META_URL.define : {}),
    },
    ...(importMetaUrl ? { banner: IMPORT_META_URL.banner } : {}),
  }));
}

export async function copyRenderer() {
  if (!existsSync(rendererDist)) {
    throw new Error(`Missing web build at ${rendererDist}. Run "turbo run build -F web" first.`);
  }

  await rm(rendererOut, { recursive: true, force: true });
  await cp(rendererDist, rendererOut, { recursive: true });
}

/**
 * Copy the server's native modules into `out/server/node_modules`, where the
 * bundled `main.cjs` resolves them; `asarUnpack` then keeps them real files.
 * Packages are resolved the way the server resolves them in dev, and copied
 * from their real paths, so pnpm's symlinks never reach the app. `cp` keeps
 * file modes, which is what keeps `spawn-helper` executable.
 */
async function copyNativeModules() {
  const fromServer = createRequire(join(root, "..", "server", "package.json"));
  const runtime = packageRootOf(fromServer.resolve(PTY_PACKAGE), PTY_PACKAGE);
  // The platform packages are the runtime package's own optional dependencies.
  const fromRuntime = createRequire(join(runtime, "package.json"));
  const names = ptyPackagesFor(process.platform, packagedArches(process.platform, process.arch));

  await rm(serverModulesOut, { recursive: true, force: true });
  for (const name of names) {
    let source;
    try {
      source = name === PTY_PACKAGE ? runtime : packageRootOf(fromRuntime.resolve(name), name);
    } catch (cause) {
      throw new Error(
        `${name} is not installed, so the packaged terminal could not start on that architecture. ` +
          `pnpm-workspace.yaml's supportedArchitectures installs it; run "pnpm install".`,
        { cause },
      );
    }
    const target = join(serverModulesOut, name);
    await cp(source, target, { recursive: true, dereference: true });
    if (name !== PTY_PACKAGE && process.platform !== "win32") {
      const file = join(target, "lib", "unixTerminal.js");
      await writeFile(file, patchHelperPath(await readFile(file, "utf8")));
    }
  }
}

/** @param {{ channel?: "stable" | "canary" }} [options] */
export async function build({ channel = "stable" } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await Promise.all(bundleOptions({ channel }).map((options) => esbuild.build(options)));
  await Promise.all([copyRenderer(), copyNativeModules()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
