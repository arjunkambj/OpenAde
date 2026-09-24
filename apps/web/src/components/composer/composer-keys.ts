/**
 * What Enter means in the composer, as a value.
 *
 * The trigger popovers (`/` commands, `#` files, `@` and `$` references) take
 * Enter to pick the highlighted item, and the composer used to claim it for them whenever a
 * trigger was open — including when the menu had nothing in it. `detectComposerTrigger` opens a `slash`
 * trigger for any `/`-prefixed token after whitespace, so "what is in
 * /etc/hosts" ends on an open menu that reads "No matching commands", and Enter
 * there did nothing at all: it neither picked, nor closed the menu, nor sent.
 * The only way out was an Escape the user had to guess at.
 *
 * So the rule is written down here instead of living inside the key handler: a
 * menu with no items does not own Enter.
 *
 * An IME comes before any menu. On macOS the Enter that commits a composition
 * arrives as a keydown with `key` "Enter" and `isComposing` set, and the
 * uncommitted Latin letters of an inline IME (pinyin, say) are already in the
 * draft — so `@le` can have skill rows open under it. That Enter belongs to the
 * IME: picking there would drop a chip into the middle of the composition.
 *
 * Plain Enter sends and Shift+Enter is a newline; those two are fixed, because
 * they depend on the menus and on IME composition. Enter with Mod, Ctrl or Alt
 * held is a chord, and chords belong to the keymap: `composer.queue` is
 * `Mod+Enter` by default, and whatever the user rebinds it to is what queues.
 * So the composer leaves those presses to the keybinding listener — once an
 * open menu with rows has had its pick.
 */

export type ComposerEnter =
  /** Take the highlighted item out of the open trigger menu. */
  | "pick"
  /** Send (or queue) the draft, closing any open menu first. */
  | "send"
  /** Leave the key to the textarea — a newline, or an IME still composing. */
  | "insert"
  /** A chord: leave it to the keybinding listener (`composer.queue`, …). */
  | "keymap";

export interface ComposerEnterInput {
  /** A trigger menu (`/`, `#`, `@` or `$`) is open. */
  readonly triggerOpen: boolean;
  /** How many rows that menu is offering. */
  readonly menuItemCount: number;
  readonly shiftKey: boolean;
  /** Meta, Ctrl or Alt is held — the press is a chord, not plain Enter. */
  readonly chord: boolean;
  /** The IME is mid-composition; Enter belongs to it. */
  readonly composing: boolean;
}

export const composerEnter = (input: ComposerEnterInput): ComposerEnter => {
  if (input.composing) {
    return "insert";
  }
  if (input.triggerOpen && input.menuItemCount > 0) {
    return "pick";
  }
  if (input.chord) {
    return "keymap";
  }
  if (input.shiftKey) {
    return "insert";
  }
  return "send";
};

/**
 * Where a key moves an open menu's highlight: Down and Tab to the next row,
 * Up and Shift+Tab to the previous one, wrapping at both ends. `null` for any
 * other key, which the menu leaves alone.
 */
export const menuMove = (
  key: string,
  shiftKey: boolean,
  index: number,
  count: number,
): number | null => {
  const size = Math.max(1, count);
  if (key === "ArrowDown" || (key === "Tab" && !shiftKey)) {
    return (index + 1) % size;
  }
  if (key === "ArrowUp" || (key === "Tab" && shiftKey)) {
    return (index - 1 + size) % size;
  }
  return null;
};
