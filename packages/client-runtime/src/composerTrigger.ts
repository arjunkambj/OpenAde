/**
 * Composer trigger detection: the `/@` tokens that open the slash-command and
 * file-mention popovers. Pure text math, shared between the textarea handler
 * and the tests — the UI adapter only supplies `text` and the caret offset.
 *
 * A trigger opens when the trigger char starts a token: at offset 0 or right
 * after whitespace, with no whitespace between it and the caret. Everything
 * after the trigger char up to the caret is the live `query`.
 */

export type ComposerTriggerKind = "slash" | "at";

export interface ComposerTrigger {
  readonly kind: ComposerTriggerKind;
  /** Offset of the trigger char — replacing `text.slice(from, to)` is the pick. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

const TRIGGER_CHARS: Readonly<Record<string, ComposerTriggerKind>> = {
  "/": "slash",
  "@": "at",
};

/** How far back from the caret a trigger may start. */
const TRIGGER_LOOKBACK = 64;

/**
 * The trigger open at `cursor`, if any. Whitespace anywhere between the
 * trigger char and the caret closes the token, so scanning stops at the first
 * space met walking backwards.
 */
export const detectComposerTrigger = (text: string, cursor: number): ComposerTrigger | null => {
  const position = Math.max(0, Math.min(cursor, text.length));
  const start = Math.max(0, position - TRIGGER_LOOKBACK);
  const slice = text.slice(start, position);

  for (let index = slice.length - 1; index >= 0; index -= 1) {
    const char = slice[index] ?? "";
    if (/\s/u.test(char)) {
      return null;
    }
    const kind = TRIGGER_CHARS[char];
    if (kind === undefined) {
      continue;
    }
    const from = start + index;
    const before = from === 0 ? "" : text.slice(from - 1, from);
    if (from !== 0 && !/\s/u.test(before)) {
      continue;
    }
    return { kind, from, to: position, query: slice.slice(index + 1) };
  }
  return null;
};

/**
 * Splice `replacement` over the trigger span, returning the next text and the
 * caret position right after the inserted text.
 */
export const replaceComposerTrigger = (
  text: string,
  trigger: ComposerTrigger,
  replacement: string,
): { readonly text: string; readonly cursor: number } => {
  const next = `${text.slice(0, trigger.from)}${replacement}${text.slice(trigger.to)}`;
  return { text: next, cursor: trigger.from + replacement.length };
};

/** True only when `token` still exists as a whole whitespace-delimited token. */
export const containsComposerToken = (text: string, token: string): boolean => {
  let from = 0;
  while (from <= text.length - token.length) {
    const index = text.indexOf(token, from);
    if (index < 0) {
      return false;
    }
    const before = index === 0 ? "" : (text[index - 1] ?? "");
    const after = text[index + token.length] ?? "";
    if ((index === 0 || /\s/u.test(before)) && (after.length === 0 || /\s/u.test(after))) {
      return true;
    }
    from = index + token.length;
  }
  return false;
};

/**
 * Drops picked references whose typed token was edited away. Called on every
 * keystroke, so it returns the same array (stable identity) when nothing
 * changed — that keeps unrelated composer chrome from re-rendering.
 */
export const retainComposerReferences = <Reference>(
  references: ReadonlyArray<Reference>,
  text: string,
  tokenFor: (reference: Reference) => string,
): ReadonlyArray<Reference> => {
  let next: Array<Reference> | null = null;
  for (let index = 0; index < references.length; index++) {
    const reference = references[index];
    if (reference === undefined) {
      continue;
    }
    if (containsComposerToken(text, tokenFor(reference))) {
      next?.push(reference);
      continue;
    }
    if (next === null) {
      next = references.slice(0, index);
    }
  }
  return next ?? references;
};
