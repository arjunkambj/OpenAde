/**
 * The browser pane's keys, matched inside the page.
 *
 * A key pressed while a pane webview has focus goes to the guest, never to
 * the window around it, so the renderer's one keybinding listener cannot see
 * it. The renderer therefore sends the shell its resolved `browser.*` chords
 * (`CHORDS_CHANNEL`), and the guest's `before-input-event` matches each keyDown
 * against them: a match is `preventDefault`ed and relayed to the embedding
 * window as the command (`COMMAND_CHANNEL`), which runs it on the pane.
 *
 * `preventDefault` there also stops the menu. The app installs no menu of its
 * own, so Electron's default one is live, and its Reload (`Cmd+R`, Force
 * Reload with Shift) reloads the whole OpenAde window — every pane tab with
 * it. Those two chords are always swallowed inside a guest, bound or not.
 *
 * Pure and Electron-free: `../ipc.ts` adapts `Electron.Input`, and the
 * sandboxed preload imports the channel names from here.
 */

export const CHORDS_CHANNEL = "openade:browser-chords";
export const COMMAND_CHANNEL = "openade:browser-command";

/** One chord, with the platform modifier already resolved to Meta or Control. */
export interface GuestChord {
  readonly command: string;
  /** Lowercase `KeyboardEvent.key`. */
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** What the window receives when a chord matched inside a guest. */
export interface GuestCommandPayload {
  readonly threadId: string;
  readonly wcId: number;
  readonly command: string;
}

/** The parts of `Electron.Input` the matcher reads. */
export interface ChordInput {
  readonly type: string;
  readonly key?: string;
  readonly meta?: boolean;
  readonly control?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly isAutoRepeat?: boolean;
}

/** What to do with one guest key event. */
export type ChordDecision =
  | { readonly kind: "pass" }
  /** Swallow it; relay `command` unless it is null (a reserved chord, or a repeat). */
  | { readonly kind: "handled"; readonly command: string | null };

const MAX_CHORDS = 32;
const COMMAND = /^browser\.[A-Za-z]+$/;

/**
 * The renderer's chords, validated: at most 32, only `browser.*` commands, and
 * well-formed keys. Anything else is dropped rather than trusted.
 */
export const parseChords = (payload: unknown): ReadonlyArray<GuestChord> => {
  if (!Array.isArray(payload)) return [];
  const chords: Array<GuestChord> = [];
  for (const entry of payload.slice(0, MAX_CHORDS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { command, key, meta, control, alt, shift } = entry as Record<string, unknown>;
    if (typeof command !== "string" || !COMMAND.test(command)) continue;
    if (typeof key !== "string" || key.length === 0 || key.length > 20) continue;
    if (![meta, control, alt, shift].every((flag) => typeof flag === "boolean")) continue;
    chords.push({
      command,
      key: key.toLowerCase(),
      meta: meta as boolean,
      control: control as boolean,
      alt: alt as boolean,
      shift: shift as boolean,
    });
  }
  return chords;
};

const matches = (chord: Omit<GuestChord, "command">, input: ChordInput): boolean =>
  (input.key ?? "").toLowerCase() === chord.key &&
  (input.meta ?? false) === chord.meta &&
  (input.control ?? false) === chord.control &&
  (input.alt ?? false) === chord.alt &&
  (input.shift ?? false) === chord.shift;

/** The default menu's Reload and Force Reload, which reload the whole window. */
const reservedChords = (platform: string): ReadonlyArray<Omit<GuestChord, "command">> => {
  const mac = platform === "darwin";
  const base = { key: "r", meta: mac, control: !mac, alt: false };
  return [
    { ...base, shift: false },
    { ...base, shift: true },
  ];
};

/**
 * A guest keyDown against the chords: a bound chord is handled and relayed
 * (not on auto-repeat, so holding `Cmd+R` reloads once); a reserved one is
 * handled and dropped; anything else passes through to the page.
 */
export const decideChord = (
  chords: ReadonlyArray<GuestChord>,
  input: ChordInput,
  platform: string,
): ChordDecision => {
  if (input.type !== "keyDown") return { kind: "pass" };
  const bound = chords.find((chord) => matches(chord, input));
  if (bound !== undefined) {
    return { kind: "handled", command: input.isAutoRepeat === true ? null : bound.command };
  }
  if (reservedChords(platform).some((chord) => matches(chord, input))) {
    return { kind: "handled", command: null };
  }
  return { kind: "pass" };
};
