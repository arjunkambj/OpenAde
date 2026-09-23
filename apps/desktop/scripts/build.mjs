import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = join(root, "out");
export const rendererDist = join(root, "..", "web", "dist");
export const rendererOut = join(outDir, "renderer");

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
    external: ["electron"],
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    logLevel: "info",
    define: {
      "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
      // `src/platform/channel.ts` derives the product name and the Windows
      // app-user-model id from this, so it has to be the channel
      // electron-builder is packaging with.
      "process.env.OPENADE_CHANNEL": JSON.stringify(channel),
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

/** @param {{ channel?: "stable" | "canary" }} [options] */
export async function build({ channel = "stable" } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await Promise.all(bundleOptions({ channel }).map((options) => esbuild.build(options)));
  await copyRenderer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}
