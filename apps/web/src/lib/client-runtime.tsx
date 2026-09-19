/**
 * The one place React meets the client runtime. `ClientRuntimeProvider`
 * builds the atom factories once from a `Connection` layer and hands them out
 * through context; components call `useClientRuntime()` to reach
 * `threadDetailAtom`, `dispatchAtom` and friends. The RPC client itself never
 * leaves the runtime: components read atoms, never a client.
 *
 * The provider takes the layer rather than resolving a connection itself so
 * the dev fixture page can substitute a scripted client without a server.
 * The real app already built its runtime in `main.tsx` (one connection for the
 * process, one shared registry), so it publishes that instance through
 * `ClientRuntimeBridge` instead of building a second one.
 */

import { RegistryProvider } from "@effect/atom-react";
import type { ConnectionLayer } from "@OpenAde/client-runtime/atoms";
import { makeRuntime } from "@OpenAde/client-runtime/atoms";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

export type ClientRuntime = ReturnType<typeof makeRuntime>;

const ClientRuntimeContext = React.createContext<ClientRuntime | null>(null);

export function ClientRuntimeProvider({
  layer,
  children,
}: {
  readonly layer: ConnectionLayer;
  readonly children: React.ReactNode;
}) {
  const [clientRuntime] = React.useState(() => makeRuntime(layer));
  return (
    <RegistryProvider>
      <ClientRuntimeContext.Provider value={clientRuntime}>
        {children}
      </ClientRuntimeContext.Provider>
    </RegistryProvider>
  );
}

/**
 * Publishes an already-built runtime — the app's own atoms — under the same
 * context the fixture page fills, so the composer, the header controls and the
 * keybinding hook are identical code in the real app and in `/dev/composer`.
 * It deliberately mounts no `RegistryProvider`: the app's registry is provided
 * once, above the router.
 */
export function ClientRuntimeBridge({
  runtime,
  children,
}: {
  readonly runtime: ClientRuntime;
  readonly children: React.ReactNode;
}) {
  return <ClientRuntimeContext.Provider value={runtime}>{children}</ClientRuntimeContext.Provider>;
}

/**
 * The atom bag to read. Without a provider this is the app's own runtime, the
 * one `main.tsx` installs — so the composer, the interaction cards and the
 * header controls mount in the real app exactly as they do on the fixture
 * page. A provider above them substitutes a scripted client instead.
 */
export function useClientRuntime(): ClientRuntime {
  return React.useContext(ClientRuntimeContext) ?? getAppAtoms();
}
