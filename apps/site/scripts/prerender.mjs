/**
 * Static prerender for the landing site.
 *
 * `vite build` emits the client bundle and an index.html shell; a second
 * `--ssr` build emits `dist-ssr/entry-server.js`. This script renders the app
 * to a string and injects it into the shell, so the deployed page is real
 * HTML — the smoke test reads it back, and first paint needs no JavaScript.
 * The client bundle then hydrates the markup via `hydrateRoot`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { render } = await import(join(root, "dist-ssr", "entry-server.js"));

const indexPath = join(root, "dist", "index.html");
const html = readFileSync(indexPath, "utf8");
const marker = '<div id="app"></div>';
if (!html.includes(marker)) {
  throw new Error("index.html is missing the app mount point");
}

writeFileSync(indexPath, html.replace(marker, `<div id="app">${render()}</div>`));
console.log("prerendered apps/site/dist/index.html");
