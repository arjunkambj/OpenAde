/**
 * The renderer-facing bridge object, built against a minimal `ipcRenderer`
 * shape instead of importing `electron`.
 *
 * `index.ts` is the only module that may touch `electron`, and it is loaded
 * by the runtime rather than by a test — so the contract the renderer type
 * declares in `@OpenAde/client-runtime/resolver` (`getConnection`,
 * `getServerState`, `onServerState`, …) is asserted here, with a fake channel,
 * rather than left to a hand-check against the running app.
 */

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverInstanceId: string;
}

/**
 * `connection` is non-null exactly while the status is `ready`, and it is a
 * *fresh* connection after a restart: the new server binds a new port and
 * mints a new token and instance id, so a client that reconnects with its
 * boot-time values would dial a dead port forever.
 */
export interface ServerState {
  readonly status: "starting" | "ready" | "restarting" | "failed";
  readonly connection: ServerConnection | null;
  /** Which restart is running, while `restarting`; null otherwise. */
  readonly attempt: number | null;
  /** Why the supervisor gave up, while `failed`; null otherwise. */
  readonly reason: string | null;
}

/** One gesture from inside a pane webview, already contract-shaped. */
export interface BrowserPaneGuestInput {
  readonly threadId: string;
  readonly input: unknown;
}

/** A main→renderer push listener: the event object, then the payload. */
export type PreloadIpcListener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * Just the three `ipcRenderer` members the bridge uses, declared so the real
 * `ipcRenderer` satisfies it structurally — no cast, so a signature drift in
 * a future Electron shows up as a type error here rather than at runtime.
 */
export interface PreloadIpc {
  readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
  readonly on: (channel: string, listener: PreloadIpcListener) => unknown;
  readonly removeListener: (channel: string, listener: PreloadIpcListener) => unknown;
}

/**
 * Subscribes to a main→renderer push channel and hands back its own
 * unsubscribe, so a renderer that unmounts stops receiving without having to
 * know the channel name.
 */
const subscribe = <A>(ipc: PreloadIpc, channel: string, callback: (payload: A) => void) => {
  const listener: PreloadIpcListener = (_event, ...args) => callback(args[0] as A);
  ipc.on(channel, listener);
  return () => {
    ipc.removeListener(channel, listener);
  };
};

export const makeOpenAdeBridge = (ipc: PreloadIpc) => ({
  getConnection: (): Promise<ServerConnection | null> =>
    ipc.invoke("openade:connection") as Promise<ServerConnection | null>,
  /** The current state, for a renderer that mounted after the last transition. */
  getServerState: (): Promise<ServerState> =>
    ipc.invoke("openade:server-state:get") as Promise<ServerState>,
  onServerState: (callback: (state: ServerState) => void): (() => void) =>
    subscribe<ServerState>(ipc, "openade:server-state", callback),
  openExternal: (url: string): Promise<void> =>
    ipc.invoke("openade:open-external", url) as Promise<void>,
  pickDirectory: (): Promise<string | null> =>
    ipc.invoke("openade:pick-directory") as Promise<string | null>,
  /**
   * Browser-pane bridge (W6 mode A): `attach` registers this window as the
   * host of the thread's `persist:thread-*` webview guest; `onInput` then
   * delivers every real pointer/keyboard/wheel gesture the guest sees —
   * already shaped like `BrowserHumanInput` — which the pane forwards as a
   * `browser.humanInput` call so the server can mark human control.
   */
  browserPane: {
    attach: (threadId: string): Promise<void> =>
      ipc.invoke("openade:browser-attach", threadId) as Promise<void>,
    detach: (threadId: string): Promise<void> =>
      ipc.invoke("openade:browser-detach", threadId) as Promise<void>,
    onInput: (callback: (payload: BrowserPaneGuestInput) => void): (() => void) =>
      subscribe<BrowserPaneGuestInput>(ipc, "openade:browser-input", callback),
  },
});
