/**
 * The main-process half of the server-state seam, kept free of `electron`
 * imports so the whole thing is unit-testable.
 *
 * Two facts the renderer depends on and that only this module can guarantee:
 *
 *  - every window gets *every* transition, including ones that happen while
 *    it is still loading, and
 *  - a window that mounted after the last transition can ask for the current
 *    state instead of waiting for one that may never come.
 *
 * Both answers go through `toPublicServerState`, so the pushed event and the
 * pulled one are the same shape — a renderer that reconnects off `connection`
 * cannot get a different answer depending on how it asked.
 */

import { toPublicServerState, type PublicServerState } from "../backend/publicServerState";
import type { ServerConnection, ServerState } from "../backend/ServerSupervisor";

/** Just what the bridge needs from the supervisor. */
export interface ServerStateSource {
  readonly current: ServerState;
  readonly connection: ServerConnection | null;
  readonly on: (event: "state", listener: (state: ServerState) => void) => unknown;
}

/** Just what the bridge needs from `ipcMain` and `BrowserWindow`. */
export interface ServerStateChannel {
  readonly handle: (channel: string, handler: () => unknown) => void;
  /** Every live window's sender; a destroyed one must not be handed back. */
  readonly senders: () => ReadonlyArray<{ send: (channel: string, payload: unknown) => void }>;
}

export const SERVER_STATE_PUSH_CHANNEL = "poseidon:server-state";
export const SERVER_STATE_GET_CHANNEL = "poseidon:server-state:get";
export const CONNECTION_CHANNEL = "poseidon:connection";

export const registerServerStateBridge = (
  channel: ServerStateChannel,
  supervisor: ServerStateSource,
): void => {
  channel.handle(CONNECTION_CHANNEL, () => supervisor.connection);
  // A window that mounts after the first starting→ready transition has no
  // event to wait for, so it asks instead.
  channel.handle(SERVER_STATE_GET_CHANNEL, (): PublicServerState =>
    toPublicServerState(supervisor.current),
  );
  supervisor.on("state", (state) => {
    const published = toPublicServerState(state);
    for (const sender of channel.senders()) {
      sender.send(SERVER_STATE_PUSH_CHANNEL, published);
    }
  });
};
