/**
 * The top-level navigation policy for the app window.
 *
 * The window is created with the preload attached, and an Electron preload
 * runs for *every* document its WebContents loads, whatever the origin. The
 * bridge that preload exposes hands out `{url, token, serverInstanceId}` for
 * the local RPC socket, so a single top-level navigation away from the app's
 * own origin would hand a remote page the bearer token for the agent — and the
 * shell has no navigation UI to come back with.
 *
 * Navigation off our origin is therefore never "follow the link here". It is
 * either refused outright or handed to the OS browser, the same way
 * `setWindowOpenHandler` already treats `target="_blank"`.
 *
 * Kept free of `electron` imports so the whole policy is unit-testable; the
 * window wires it to `will-navigate` and `will-frame-navigate`.
 */

export type NavigationDecision =
  /** Our own renderer — the app navigating within itself. */
  | { readonly kind: "allow" }
  /** Off-origin http(s): the OS browser gets it, this window does not. */
  | { readonly kind: "external"; readonly url: string }
  /** Anything else (`file:`, `data:`, `blob:`, a malformed url). */
  | { readonly kind: "block"; readonly reason: string };

export interface NavigationPolicy {
  /** The packaged renderer's url, `openade://app/`. */
  readonly appUrl: string;
  /** `ELECTRON_RENDERER_URL` in dev, where the renderer is served over http. */
  readonly devServerUrl?: string | undefined;
}

/** Protocol + host, or `null` when the url does not parse. */
const authorityOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

export const decideNavigation = (url: string, policy: NavigationPolicy): NavigationDecision => {
  const authority = authorityOf(url);
  if (authority === null) {
    return { kind: "block", reason: `unparseable url ${JSON.stringify(url)}` };
  }

  // The renderer's own origin, and in dev the origin Vite serves it from.
  const allowed = [policy.appUrl, policy.devServerUrl]
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
    .map(authorityOf);
  if (allowed.includes(authority)) return { kind: "allow" };

  const protocol = new URL(url).protocol;
  if (protocol === "http:" || protocol === "https:") {
    return { kind: "external", url };
  }
  return { kind: "block", reason: `${protocol} navigation is not allowed` };
};
