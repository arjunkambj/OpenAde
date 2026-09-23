/**
 * The native modules the bundled server loads at runtime, and which of their
 * packages the app has to carry. esbuild leaves them external, so in the
 * packaged app they must sit in `out/server/node_modules`, beside `main.cjs`,
 * where Node's resolution from the bundle finds them.
 *
 * Only pure selection logic lives here; `build.mjs` does the copying.
 */
import { sep } from "node:path";

/**
 * The pty module the integrated terminal loads. Its runtime package is a small
 * loader that picks `@lydell/node-pty-<platform>-<arch>` by `process.arch`, and
 * each of those carries one prebuilt N-API binary plus `spawn-helper`.
 */
export const PTY_PACKAGE = "@lydell/node-pty";

/**
 * The architectures a platform's app is packaged for, so each packaged app
 * carries the binary its own `process.arch` asks for. macOS and Windows build
 * arm64 and x64 from one host (`electron-builder.config.cjs`), so both
 * binaries ride along in every app; Linux builds only the host's.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} hostArch
 * @returns {string[]}
 */
export function packagedArches(platform, hostArch) {
  const arches = platform === "darwin" || platform === "win32" ? ["arm64", "x64"] : [];
  return [...new Set([hostArch, ...arches])];
}

/**
 * The packages to copy for the pty module: the runtime loader, then one
 * platform package per architecture, in order and without repeats.
 *
 * @param {NodeJS.Platform} platform
 * @param {readonly string[]} arches
 * @returns {string[]}
 */
export function ptyPackagesFor(platform, arches) {
  return [PTY_PACKAGE, ...new Set(arches.map((arch) => `${PTY_PACKAGE}-${platform}-${arch}`))];
}

/**
 * The root directory of package `name`, given any file resolved inside it —
 * `.../node_modules/@lydell/node-pty/index.js` gives
 * `.../node_modules/@lydell/node-pty`. The last `node_modules/<name>` wins, so
 * a store path with `node_modules` further up still gives the package itself.
 *
 * @param {string} resolvedFile
 * @param {string} name
 * @returns {string}
 */
export function packageRootOf(resolvedFile, name) {
  const marker = `${sep}node_modules${sep}${name.split("/").join(sep)}`;
  const at = resolvedFile.lastIndexOf(`${marker}${sep}`);
  if (at === -1) throw new Error(`${resolvedFile} is not inside package ${name}`);
  return resolvedFile.slice(0, at + marker.length);
}

/** The line in node-pty's `lib/unixTerminal.js` that locates `spawn-helper`. */
const HELPER_ASAR_LINE = "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";

/**
 * node-pty points `spawn-helper` out of the asar archive by rewriting the first
 * `app.asar` in its own path to `app.asar.unpacked`. The bundled server runs
 * from `app.asar.unpacked` already, so that turns the path into
 * `app.asar.unpacked.unpacked` and every spawn fails. Rewrite only an
 * `app.asar` that is a whole path segment, which leaves an unpacked path alone.
 *
 * Throws when the line is missing, so a node-pty upgrade that changes it
 * fails the build instead of shipping a terminal that cannot start.
 *
 * @param {string} source the contents of `lib/unixTerminal.js`
 * @returns {string}
 */
export function patchHelperPath(source) {
  if (!source.includes(HELPER_ASAR_LINE)) {
    throw new Error("node-pty's spawn-helper path line changed; revisit patchHelperPath");
  }
  return source.replace(
    HELPER_ASAR_LINE,
    "helperPath = helperPath.replace(/app\\.asar(?=[\\\\/])/, 'app.asar.unpacked');",
  );
}
