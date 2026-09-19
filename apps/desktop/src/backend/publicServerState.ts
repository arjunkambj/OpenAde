/**
 * The server state as the renderer sees it.
 *
 * The supervisor's own state is a discriminated union; the bridge publishes the
 * flat shape the client runtime reconnects against, carrying each variant's
 * payload in a field that is null under the other variants. A restarted server
 * binds a new port and mints a new token and instance id, so carrying the
 * connection on the event is what lets a reconnect dial the new server instead
 * of the dead one — and `attempt`/`reason` are what let the crash banner say
 * which retry is running and why the server gave up, rather than just
 * "failed".
 */
import type { ServerConnection, ServerState } from "./ServerSupervisor";

export interface PublicServerState {
  readonly status: ServerState["status"];
  /** Non-null exactly while the status is `ready`. */
  readonly connection: ServerConnection | null;
  /** Which restart this is, while the status is `restarting`. */
  readonly attempt: number | null;
  /** Why the supervisor stopped retrying, while the status is `failed`. */
  readonly reason: string | null;
}

export const toPublicServerState = (state: ServerState): PublicServerState => ({
  status: state.status,
  connection: state.status === "ready" ? state.connection : null,
  attempt: state.status === "restarting" ? state.attempt : null,
  reason: state.status === "failed" ? state.reason : null,
});
