/**
 * The pane's human-input relay.
 *
 * `before-input-event` and `before-mouse-event` on a guest's webContents are
 * the only place a gesture inside a pane webview is observable from outside
 * it. Each guest is hooked once, when it is created, and every gesture goes to
 * whatever window embeds the guest at that moment, tagged with the guest's
 * thread and `webContents` id; the renderer forwards it as
 * `browser.humanInput`, which is what interrupts an in-flight agent call.
 *
 * Input the agent synthesizes over CDP fires neither event, so everything
 * relayed here is a person.
 *
 * Electron-free: `../ipc.ts` adapts a real `webContents` to `RelayGuest`.
 */

/** One gesture from inside a pane webview, already contract-shaped. */
export type GuestInput =
  | { readonly kind: "click"; readonly x: number; readonly y: number; readonly button?: string }
  | {
      readonly kind: "key";
      readonly key: string;
      readonly modifiers?: ReadonlyArray<"alt" | "ctrl" | "meta" | "shift">;
    }
  | { readonly kind: "scroll"; readonly deltaX: number; readonly deltaY: number };

/** What the embedder receives on `INPUT_CHANNEL`. */
export interface GuestInputPayload {
  readonly threadId: string;
  readonly wcId: number;
  readonly input: GuestInput;
}

export const INPUT_CHANNEL = "openade:browser-input";

/** The parts of `Electron.Input` the relay reads. */
export interface KeyLike {
  readonly type: string;
  readonly key?: string;
  readonly modifiers?: ReadonlyArray<string>;
}

/** The parts of `Electron.MouseInputEvent` (and its wheel variant) the relay reads. */
export interface MouseLike {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly button?: string;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export interface RelayHost {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: GuestInputPayload) => void;
}

export interface RelayGuest {
  readonly id: number;
  readonly onKey: (listener: (input: KeyLike) => void) => void;
  readonly onMouse: (listener: (mouse: MouseLike) => void) => void;
  /** The embedding window's webContents right now, or `null`. */
  readonly host: () => RelayHost | null;
}

const MODIFIERS: Readonly<Record<string, "alt" | "ctrl" | "meta" | "shift">> = {
  alt: "alt",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  shift: "shift",
};

export const keyInput = (input: KeyLike): GuestInput | null => {
  // keyDown only — char/rawKeyDown/keyUp would double-report.
  if (input.type !== "keyDown") return null;
  const modifiers: Array<"alt" | "ctrl" | "meta" | "shift"> = [];
  for (const name of input.modifiers ?? []) {
    const modifier = MODIFIERS[name];
    if (modifier !== undefined && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { kind: "key", key: input.key ?? "", ...(modifiers.length > 0 ? { modifiers } : {}) };
};

export const mouseInput = (mouse: MouseLike): GuestInput | null => {
  if (mouse.type === "mouseDown" || mouse.type === "contextMenu") {
    return {
      kind: "click",
      x: mouse.x,
      y: mouse.y,
      ...(mouse.button === undefined ? {} : { button: mouse.button }),
    };
  }
  if (mouse.type === "mouseWheel") {
    return { kind: "scroll", deltaX: mouse.deltaX ?? 0, deltaY: mouse.deltaY ?? 0 };
  }
  return null;
};

export interface GuestInputRelay {
  /** Hooks a guest once; a second call for the same guest does nothing. */
  readonly hook: (guest: RelayGuest, threadId: string) => void;
  /** The guest was destroyed. */
  readonly forget: (wcId: number) => void;
}

export const makeGuestInputRelay = (): GuestInputRelay => {
  const hooked = new Set<number>();
  return {
    hook: (guest, threadId) => {
      if (hooked.has(guest.id)) return;
      hooked.add(guest.id);
      const relay = (input: GuestInput | null) => {
        const host = guest.host();
        if (input === null || host === null || host.isDestroyed()) return;
        host.send(INPUT_CHANNEL, { threadId, wcId: guest.id, input });
      };
      guest.onKey((input) => relay(keyInput(input)));
      guest.onMouse((mouse) => relay(mouseInput(mouse)));
    },
    forget: (wcId) => {
      hooked.delete(wcId);
    },
  };
};
