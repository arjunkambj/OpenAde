/**
 * Finds `{ url, token }` for the current process, in order:
 * `window.openade.getConnection()` (Electron preload) →
 * `GET /__openade/connection` (the dev Vite plugin) →
 * `?server=<url>&token=<t>` search params.
 *
 * Everything is guarded so this file also evaluates under plain `node` for
 * tests — it just reports `null` when no channel answers.
 */

export interface ResolvedConnection {
  readonly url: string;
  readonly token: string;
}

declare global {
  interface Window {
    /**
     * The desktop preload bridge (apps/desktop/src/preload). Every member is
     * optional — a browser tab has none of them, and older builds may lack the
     * newer ones.
     */
    readonly openade?: {
      readonly getConnection?: () => Promise<ResolvedConnection | null> | ResolvedConnection | null;
      /** Native directory picker; resolves `null` when the user cancels. */
      readonly pickDirectory?: () => Promise<string | null>;
      /** Opens `url` in the system browser — the only sanctioned way out. */
      readonly openExternal?: (url: string) => Promise<void>;
    };
  }
}

const fromPreload = async (): Promise<ResolvedConnection | null> => {
  if (typeof window === "undefined" || window.openade?.getConnection === undefined) {
    return null;
  }
  return (await window.openade.getConnection()) ?? null;
};

const fromDevEndpoint = async (): Promise<ResolvedConnection | null> => {
  if (typeof fetch === "undefined" || typeof window === "undefined") {
    return null;
  }
  try {
    const response = await fetch("/__openade/connection", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Partial<ResolvedConnection>;
    return typeof body.url === "string" && typeof body.token === "string"
      ? { url: body.url, token: body.token }
      : null;
  } catch {
    return null;
  }
};

const fromSearchParams = (): ResolvedConnection | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const url = params.get("server");
  const token = params.get("token");
  return url !== null && token !== null ? { url, token } : null;
};

/**
 * `null` means "no channel configured" — the UI shows its connect screen.
 *
 * @public The web entry point calls this before mounting the atom runtime.
 */
export const resolveConnection = async (): Promise<ResolvedConnection | null> =>
  (await fromPreload()) ?? (await fromDevEndpoint()) ?? fromSearchParams();
