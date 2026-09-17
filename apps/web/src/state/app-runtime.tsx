/**
 * The renderer's atom runtime wiring.
 *
 * `main.tsx` resolves the connection, then `installAppAtoms` builds the
 * `AtomRuntime` layer once — `makeConnection` when a server is reachable, an
 * offline layer otherwise. The offline layer keeps every atom mountable (lists
 * stay empty, the connection state reads "disconnected") so components never
 * branch on "is there a runtime".
 *
 * `appAtomRegistry` is the one registry the whole app shares — mounted atoms
 * (and the connection's supervisor fibers) live exactly as long as their
 * subscribers.
 */

import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { makeRuntime } from "@OpenAde/client-runtime/atoms";
import {
  Connection,
  ConnectionStateRef,
  makeConnection,
  type ConnectionState,
} from "@OpenAde/client-runtime/connection";
import type { ResolvedConnection } from "@OpenAde/client-runtime/resolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

export type AppAtoms = ReturnType<typeof makeRuntime>;

const appAtomRegistry = AtomRegistry.make({ scheduleTask });

export function AppAtomRegistryProvider({ children }: { children?: ReactNode }) {
  return <RegistryContext.Provider value={appAtomRegistry}>{children}</RegistryContext.Provider>;
}

/**
 * No server resolved: `client` never resolves and the state stays
 * `disconnected`, so subscribers render their empty states instead of hanging
 * or throwing.
 */
const offlineConnectionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ConnectionState>({
      status: "disconnected",
      serverInstanceId: null,
    });
    return Layer.mergeAll(
      Layer.succeed(Connection, Connection.of({ client: Effect.never, state })),
      Layer.succeed(ConnectionStateRef, state),
    );
  }),
);

let appAtoms: AppAtoms | null = null;
let resolvedConnection: ResolvedConnection | null = null;

export const installAppAtoms = (resolved: ResolvedConnection | null): AppAtoms => {
  resolvedConnection = resolved;
  appAtoms ??= makeRuntime(resolved === null ? offlineConnectionLayer : makeConnection(resolved));
  return appAtoms;
};

/** What `resolveConnection` found at boot — the /welcome page displays it. */
export const getResolvedConnection = (): ResolvedConnection | null => resolvedConnection;

/**
 * The server's http(s) origin, derived from the socket url. Loopback routes
 * that are not RPC live on it — the browser pane's attach marker, which the
 * desktop `<webview>` loads so the CDP driver can recognise that guest.
 *
 * `null` when no connection resolved: a relative marker url would resolve
 * against the renderer's own origin and load the app's SPA into the guest,
 * so callers must skip the webview rather than build one out of "".
 */
export const getHttpBase = (): string | null => {
  const url = resolvedConnection?.url;
  if (url === undefined || url === "") return null;
  return (url.startsWith("ws") ? `http${url.slice(2)}` : url).replace(/\/ws\/?$/, "");
};

export const getAppAtoms = (): AppAtoms => {
  if (appAtoms === null) {
    throw new Error("app atoms not installed — installAppAtoms must run before render");
  }
  return appAtoms;
};
