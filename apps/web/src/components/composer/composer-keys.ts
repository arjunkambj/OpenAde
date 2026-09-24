/**
 * What Enter means in the composer, as a value.
 *
 * The trigger popovers (`/` commands, `#` files) take Enter to pick the
 * highlighted item, and the composer used to claim it for them whenever a
 * trigger was open — including when the menu had nothing in it. `detectComposerTrigger` opens a `slash`
 * trigger for any `/`-prefixed token after whitespace, so "what is in
 * /etc/hosts" ends on an open menu that reads "No matching commands", and Enter
 * there did nothing at all: it neither picked, nor closed the menu, nor sent.
 * The only way out was an Escape the user had to guess at.
 *
 * So the rule is written down here instead of living inside the key handler: a
 * menu with no items does not own Enter.
 */

export type ComposerEnter =
  /** Take the highlighted item out of the open trigger menu. */
  | "pick"
  /** Send (or queue) the draft, closing any open menu first. */
  | "send"
  /** Leave the key to the textarea — a newline, or an IME still composing. */
  | "insert";

export interface ComposerEnterInput {
  /** A trigger menu (`/` or `#`) is open. */
  readonly triggerOpen: boolean;
  /** How many rows that menu is offering. */
  readonly menuItemCount: number;
  readonly shiftKey: boolean;
  /** The IME is mid-composition; Enter belongs to it. */
  readonly composing: boolean;
}

export const composerEnter = (input: ComposerEnterInput): ComposerEnter => {
  if (input.triggerOpen && input.menuItemCount > 0) {
    return "pick";
  }
  if (input.composing || input.shiftKey) {
    return "insert";
  }
  return "send";
};
