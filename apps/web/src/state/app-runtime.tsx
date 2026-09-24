/**
 * The renderer's atom runtime wiring.
 *
 * `main.tsx` resolves the connection, then `installAppAtoms` builds the
 * `AtomRuntime` layer once — `makeConnection` when a server is reachable or a
 * desktop supervisor is still bringing one up, an offline layer otherwise. The
 * offline layer keeps every atom mountable (lists stay empty, the connection
 * state reads "disconnected") so components never branch on "is there a
 * runtime".
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
import { resolveConnection, type ResolvedConnection } from "@OpenAde/client-runtime/resolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

export type AppAtoms = ReturnType<typeof makeRuntime>;

const appAtomRegistry = AtomRegistry.make({ scheduleTask });

/**
 * The registry itself, for code that runs outside React — an entry point a
 * click handler calls, like `openInThreadBrowser`.
 */
export const getAppAtomRegistry = (): AtomRegistry.AtomRegistry => appAtomRegistry;

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

/**
 * Every reconnect attempt goes back to the channel instead of reusing the
 * credentials boot resolved: a supervisor-restarted server has a new port and
 * a new token, and the frozen pair would loop against a dead port forever.
 */
const reresolve = Effect.promise(() => resolveConnection().catch(() => null));

/**
 * Is there a desktop supervisor behind this window? If so, "nothing resolved"
 * means "not yet": `createWindow` does not wait for the server to be up, so a
 * cold boot paints while the supervisor is still `starting` and no channel has
 * a port to hand out. Pinning the offline layer there would leave the window
 * disconnected until the user reloaded it by hand, so the connection is built
 * with nothing but `resolve` and its attempt loop picks the server up as soon
 * as the handshake lands.
 *
 * A plain browser tab with no channel really is offline, and gets the offline
 * layer and the banner that says so.
 */
const hasDesktopSupervisor = (): boolean =>
  typeof window !== "undefined" &&
  (window.openade?.onServerState !== undefined || window.openade?.getServerState !== undefined);

export const installAppAtoms = (resolved: ResolvedConnection | null): AppAtoms => {
  appAtoms ??= makeRuntime(
    resolved !== null
      ? makeConnection({ ...resolved, resolve: reresolve })
      : hasDesktopSupervisor()
        ? makeConnection({ resolve: reresolve })
        : offlineConnectionLayer,
  );
  return appAtoms;
};

export const getAppAtoms = (): AppAtoms => {
  if (appAtoms === null) {
    throw new Error("app atoms not installed — installAppAtoms must run before render");
  }
  return appAtoms;
};
