/**
 * Composer trigger detection: the `/` and `#` tokens that open the
 * slash-command and file-mention popovers. Pure text math, shared between the
 * textarea handler and the tests — the UI adapter only supplies `text` and the
 * caret offset.
 *
 * A trigger opens when the trigger char starts a token: at offset 0 or right
 * after whitespace, with no whitespace between it and the caret. Everything
 * after the trigger char up to the caret is the live `query`. That rule alone
 * keeps `a#b`, `foo/bar` and `https://x.dev/#frag` closed.
 *
 * A kind may add a rule about its query on top (`QUERY_RULES`). `#` has one,
 * because `#` is also markdown: it opens only once a query has started and
 * that query does not begin with another `#`. So a lone `#` followed by Enter
 * sends rather than picking a file, `# Heading` closes at the space before a
 * menu ever shows, and `##` / `### ` headings never open it. `#12` (an issue
 * number) does open, with query `12`; it lists no files, and a menu with no
 * rows does not own Enter (`composer-keys` in the web app), so it still sends.
 */

/** Named for what each menu lists: `slash` commands, `file` mentions (`#`). */
export type ComposerTriggerKind = "slash" | "file";

export interface ComposerTrigger {
  readonly kind: ComposerTriggerKind;
  /** Offset of the trigger char — replacing `text.slice(from, to)` is the pick. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

const TRIGGER_CHARS: Readonly<Record<string, ComposerTriggerKind>> = {
  "/": "slash",
  "#": "file",
};

/** Extra per-kind rules on the query; a kind without one opens on any query. */
const QUERY_RULES: Readonly<Partial<Record<ComposerTriggerKind, (query: string) => boolean>>> = {
  file: (query) => query.length > 0 && !query.startsWith("#"),
};

/** How far back from the caret a trigger may start. */
const TRIGGER_LOOKBACK = 64;

/**
 * The trigger open at `cursor`, if any. Whitespace anywhere between the
 * trigger char and the caret closes the token, so scanning stops at the first
 * space met walking backwards. Only the token's first char can open a menu, so
 * when its kind's query rule declines, nothing opens.
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
    const query = slice.slice(index + 1);
    if (QUERY_RULES[kind]?.(query) === false) {
      return null;
    }
    return { kind, from, to: position, query };
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
