/**
 * The `app://` scheme serves the bundled renderer with SPA fallback so the
 * history router keeps working inside Electron.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

export const APP_SCHEME = "app";
export const APP_URL = `${APP_SCHEME}://openade/`;

const rendererRoot = normalize(join(__dirname, "..", "renderer"));

export function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidate = normalize(join(rendererRoot, relative));
    const file =
      candidate !== rendererRoot &&
      candidate.startsWith(rendererRoot + sep) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
        ? candidate
        : join(rendererRoot, "index.html");
    return net.fetch(pathToFileURL(file).toString());
  });
}
