/**
 * The server state as the renderer sees it.
 *
 * The supervisor's own state is a discriminated union carrying an attempt
 * count and a failure reason; the bridge publishes the flat shape the client
 * runtime reconnects against — a status plus the live connection, which is
 * non-null exactly while the server is ready. A restarted server binds a new
 * port and mints a new token and instance id, so carrying the connection on
 * the event is what lets a reconnect dial the new server instead of the dead
 * one.
 */
import type { ServerConnection, ServerState } from "./ServerSupervisor";

export interface PublicServerState {
  readonly status: ServerState["status"];
  readonly connection: ServerConnection | null;
}

export const toPublicServerState = (state: ServerState): PublicServerState => ({
  status: state.status,
  connection: state.status === "ready" ? state.connection : null,
});
