/**
 * What `poseidon://app/<path>` resolves to.
 *
 * The SPA fallback exists for the history router: `/threads/abc` has no file
 * behind it and must still serve the shell. It must not swallow a missing
 * asset, though — answering `index.html` with a 200 for `/assets/main.js`
 * hands the renderer HTML under a JS content type, and the only symptom is an
 * opaque MIME error. A request that names a file gets a 404 instead.
 *
 * Kept free of `electron` so the routing is unit-testable.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

export type RendererRequest =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "shell"; readonly path: string }
  | { readonly kind: "notFound" };

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A last segment like `main.abc123.js` — a request for a file, not a route. */
const namesAFile = (pathname: string): boolean =>
  /\.[A-Za-z0-9]+$/.test(pathname.split("/").pop() ?? "");

export const resolveRendererRequest = (
  rendererRoot: string,
  pathname: string,
  accept: string | null,
): RendererRequest => {
  const shell = join(rendererRoot, "index.html");
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return { kind: "notFound" };
  }

  const candidate = normalize(join(rendererRoot, relative));
  if (candidate !== rendererRoot && !candidate.startsWith(rendererRoot + sep)) {
    // A path that climbs out of the renderer root is never served.
    return { kind: "notFound" };
  }
  if (candidate !== rendererRoot && isFile(candidate)) {
    return { kind: "file", path: candidate };
  }
  if (namesAFile(relative) && !(accept ?? "").includes("text/html")) {
    return { kind: "notFound" };
  }
  return { kind: "shell", path: shell };
};
