/**
 * The `openade://app/` scheme serves the bundled renderer with SPA fallback so
 * the history router keeps working inside Electron.
 *
 * The scheme is the product's own, not the generic
 * `app://` the scaffold used: the renderer's origin is what any origin check or
 * CSP is written against, and `app://` is one every other Electron app on the
 * machine may also claim.
 */
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { resolveRendererRequest } from "./rendererRequest";

export const APP_SCHEME = "openade";
export const APP_URL = `${APP_SCHEME}://app/`;

const rendererRoot = normalize(join(__dirname, "..", "renderer"));

export function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const resolved = resolveRendererRequest(rendererRoot, pathname, request.headers.get("accept"));
    if (resolved.kind === "notFound") {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved.path).toString());
  });
}
