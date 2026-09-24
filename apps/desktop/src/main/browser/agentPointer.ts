/**
 * Where the agent points: the bridge's native mouse input, told to the window
 * so the pane can draw the agent's cursor and a pulse where it clicks.
 *
 * Every `Input.dispatchMouseEvent` an agent client sends passes through the
 * bridge (`./bridgeSession`), which hands it here before it reaches the guest.
 * A press is always told; moves are thinned to one per interval per tab,
 * because agent-browser can sweep the pointer in many small steps and each one
 * is an IPC message and a render. Releases, wheels and key input are not told:
 * the press already marks the click, and nothing else has a place to draw.
 *
 * `x` and `y` are what the agent sent — CSS pixels of the page's viewport —
 * and the window scales them by the tab's zoom onto the pane
 * (`apps/web/src/components/browser-host/pointer-transform.ts`).
 *
 * Electron-free, with no imports, so the sandboxed preload can take the
 * channel name and payload type from here.
 */

export const POINTER_CHANNEL = "openade:browser-agent-pointer";

export type AgentPointerKind = "move" | "press";

/** What the window receives on `POINTER_CHANNEL`. */
export interface AgentPointer {
  readonly threadId: string;
  /** The guest's `webContents` id: which tab of the thread. */
  readonly wcId: number;
  readonly x: number;
  readonly y: number;
  readonly kind: AgentPointerKind;
}

/** The pointer a CDP command moves, or `null` for anything that is not mouse movement or a press. */
export const pointerOf = (
  method: string,
  params: unknown,
): { readonly x: number; readonly y: number; readonly kind: AgentPointerKind } | null => {
  if (method !== "Input.dispatchMouseEvent" || typeof params !== "object" || params === null) {
    return null;
  }
  const { type, x, y } = params as Readonly<Record<string, unknown>>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x + y)) return null;
  if (type === "mousePressed") return { x, y, kind: "press" };
  if (type === "mouseMoved") return { x, y, kind: "move" };
  return null;
};

/** How often a tab's pointer moves are told at most. */
export const MOVE_INTERVAL_MS = 50;

export interface PointerRelayOptions {
  readonly send: (pointer: AgentPointer) => void;
  readonly now?: () => number;
  readonly moveIntervalMs?: number;
}

/** Sees each agent input command; tells the window the ones it can draw. */
export type PointerRelay = (
  threadId: string,
  wcId: number,
  method: string,
  params: unknown,
) => void;

export const makePointerRelay = (options: PointerRelayOptions): PointerRelay => {
  const now = options.now ?? Date.now;
  const interval = options.moveIntervalMs ?? MOVE_INTERVAL_MS;
  const lastMove = new Map<number, number>();
  return (threadId, wcId, method, params) => {
    const pointer = pointerOf(method, params);
    if (pointer === null) return;
    if (pointer.kind === "move") {
      const at = now();
      const last = lastMove.get(wcId);
      if (last !== undefined && at - last < interval) return;
      lastMove.set(wcId, at);
    }
    options.send({ threadId, wcId, ...pointer });
  };
};
