/**
 * The app's atom runtime, built lazily on first use. Resolves the server
 * connection (Electron preload → dev endpoint → search params), opens the
 * WebSocket connection layer, and exposes `makeRuntime`'s atoms plus the
 * server's HTTP base for loopback routes like the browser attach marker.
 */
import * as React from "react";

import { makeRuntime } from "@OpenAde/client-runtime/atoms";
import { makeConnection } from "@OpenAde/client-runtime/connection";
import { resolveConnection } from "@OpenAde/client-runtime/resolver";

export interface AppRuntime {
  readonly atoms: ReturnType<typeof makeRuntime>;
  /** http(s) origin of the server — the `/browser/attach/*` route lives on it. */
  readonly httpBase: string;
}

const httpBaseOf = (url: string): string =>
  (url.startsWith("ws") ? `http${url.slice(2)}` : url).replace(/\/ws\/?$/, "");

let cached: Promise<AppRuntime | null> | null = null;

const getRuntime = (): Promise<AppRuntime | null> => {
  cached ??= (async () => {
    const connection = await resolveConnection();
    if (connection === null) return null;
    return {
      atoms: makeRuntime(makeConnection(connection)),
      httpBase: httpBaseOf(connection.url),
    };
  })();
  return cached;
};

/** `null` until the connection resolves; the pane renders its connect shell. */
export const useAppRuntime = (): AppRuntime | null => {
  const [runtime, setRuntime] = React.useState<AppRuntime | null>(null);
  React.useEffect(() => {
    let alive = true;
    void getRuntime().then((value) => {
      if (alive) setRuntime(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return runtime;
};
