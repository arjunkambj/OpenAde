/**
 * The one place React meets the client runtime. `ClientRuntimeProvider`
 * builds the atom factories once from a `Connection` layer and hands them out
 * through context; components call `useClientRuntime()` to reach
 * `threadDetailAtom`, `dispatchAtom` and friends. The RPC client itself never
 * leaves the runtime — that is the renderer rule in spec section 11.
 *
 * The provider takes the layer rather than resolving a connection itself so
 * the dev fixture page can substitute a scripted client without a server.
 */

import { RegistryProvider } from "@effect/atom-react";
import type { ConnectionLayer } from "@OpenAde/client-runtime/atoms";
import { makeRuntime } from "@OpenAde/client-runtime/atoms";
import * as React from "react";

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

export function useClientRuntime(): ClientRuntime {
  const runtime = React.useContext(ClientRuntimeContext);
  if (runtime === null) {
    throw new Error("useClientRuntime must be used under <ClientRuntimeProvider>");
  }
  return runtime;
}
