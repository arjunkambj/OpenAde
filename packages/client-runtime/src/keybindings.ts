/**
 * The keybinding matcher: parses the `Keybinding.shortcut` notation
 * (`Cmd+Shift+B`, `Escape`), matches it against a `KeyboardEvent`-shaped value,
 * and evaluates the optional `when` clause against caller-supplied context.
 *
 * `Cmd` is the platform modifier — Meta on macOS/iOS, Ctrl elsewhere — so one
 * stored binding works on every keyboard. `Ctrl` means the physical Control
 * key everywhere. Matching is exact on modifiers: `Escape` does not fire on
 * `Shift+Escape`, and `Cmd+K` does not fire on `Cmd+Alt+K`.
 *
 * `when` is a small expression over context flags: `composerFocus`,
 * `!composerFocus`, `a && b`, `a || b`, parentheses, and `flag == "value"`.
 * Unknown flags evaluate as false, so a binding for a context that does not
 * exist yet is simply inert.
 */

import type { Keybinding } from "@OpenAde/contracts/settings";

// ── Shortcut parsing ───────────────────────────────────────────

export interface ParsedShortcut {
  /** Normalised `event.key` — lowercase for letters, `enter`, `escape`, ` `… */
  readonly key: string;
  /** The platform modifier: Meta on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
  /** Physical Control, on every platform. */
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type ModKey = "meta" | "ctrl";

/** The platform modifier this machine reports through `event.metaKey` or not. */
export const detectModKey = (): ModKey =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)
    ? "meta"
    : "ctrl";

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  space: " ",
  spacebar: " ",
  del: "delete",
  delete: "delete",
  backspace: "backspace",
  tab: "tab",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  arrowup: "arrowup",
  arrowdown: "arrowdown",
  arrowleft: "arrowleft",
  arrowright: "arrowright",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  comma: ",",
  plus: "+",
  minus: "-",
};

const MODIFIER_TOKENS = new Set([
  "cmd",
  "mod",
  "meta",
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
]);

const normaliseKey = (token: string): string | null => {
  const lower = token.toLowerCase();
  const aliased = KEY_ALIASES[lower] ?? lower;
  return MODIFIER_TOKENS.has(aliased) ? null : aliased;
};

/**
 * `Cmd+Shift+B` → `{ key: "b", mod: true, shift: true }`. Returns null when
 * the chord has no non-modifier key — a bare `Cmd` is not a shortcut.
 */
export const parseShortcut = (notation: string): ParsedShortcut | null => {
  const parts = notation.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return null;
  }
  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "cmd" || lower === "mod" || lower === "meta") {
      mod = true;
    } else if (lower === "ctrl" || lower === "control") {
      ctrl = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else if (lower === "shift") {
      shift = true;
    } else {
      const normalised = normaliseKey(part);
      if (normalised === null || key !== null) {
        return null;
      }
      key = normalised;
    }
  }
  return key === null ? null : { key, mod, ctrl, alt, shift };
};

// ── Matching ───────────────────────────────────────────────────

/** The subset of `KeyboardEvent` the matcher reads — structural, DOM-free. */
export interface ShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const eventKey = (event: ShortcutEvent): string => {
  const lower = event.key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
};

/**
 * Exact-modifier match. `mod` is the platform modifier — `metaKey` on macOS,
 * `ctrlKey` elsewhere — while `ctrl` always means the physical Control key.
 * Undeclared modifiers must not be held: `Cmd+K` does not fire on
 * `Cmd+Alt+K`, and `Escape` does not fire on `Shift+Escape`.
 */
export const matchShortcut = (
  shortcut: ParsedShortcut,
  event: ShortcutEvent,
  modKey: ModKey,
): boolean => {
  if (eventKey(event) !== shortcut.key) {
    return false;
  }
  const expectedCtrl = shortcut.ctrl || (modKey === "ctrl" && shortcut.mod);
  const expectedMeta = modKey === "meta" && shortcut.mod;
  return (
    event.ctrlKey === expectedCtrl &&
    event.metaKey === expectedMeta &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
};

/**
 * Turns a captured `KeyboardEvent` back into `Cmd+Shift+B` notation for the
 * editor's record field. Modifier-only presses return null so holding Cmd
 * while deciding does not commit anything.
 */
export const formatEventAsShortcut = (event: ShortcutEvent, modKey: ModKey): string | null => {
  const key = eventKey(event);
  if (MODIFIER_TOKENS.has(key) || key === "control") {
    return null;
  }
  const parts: Array<string> = [];
  const modPressed = modKey === "meta" ? event.metaKey : event.ctrlKey;
  const otherPressed = modKey === "meta" ? event.ctrlKey : event.metaKey;
  if (modPressed) {
    parts.push("Cmd");
  }
  if (otherPressed) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(
    key === " "
      ? "Space"
      : key.length === 1
        ? key.toUpperCase()
        : `${key[0]!.toUpperCase()}${key.slice(1)}`,
  );
  return parts.join("+");
};

// ── `when` evaluation ──────────────────────────────────────────

/** The values a `when` clause may read: flags, or strings for `==`/`!=`. */
export type WhenContext = (name: string) => boolean | string | undefined;

type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "op"; readonly value: "!" | "&&" | "||" | "(" | ")" | "==" | "!=" };

const tokenizeWhen = (source: string): ReadonlyArray<Token> | null => {
  const tokens: Array<Token> = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === "!") {
      if (char === "!" && source[index + 1] === "=") {
        tokens.push({ kind: "op", value: "!=" });
        index += 2;
      } else {
        tokens.push({ kind: "op", value: char });
        index += 1;
      }
      continue;
    }
    if (char === "&" && source[index + 1] === "&") {
      tokens.push({ kind: "op", value: "&&" });
      index += 2;
      continue;
    }
    if (char === "|" && source[index + 1] === "|") {
      tokens.push({ kind: "op", value: "||" });
      index += 2;
      continue;
    }
    if (char === "=" && source[index + 1] === "=") {
      tokens.push({ kind: "op", value: "==" });
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) {
        return null;
      }
      tokens.push({ kind: "string", value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    const ident = /^[A-Za-z_][\w-]*/u.exec(source.slice(index));
    if (ident === null) {
      return null;
    }
    tokens.push({ kind: "ident", value: ident[0] });
    index += ident[0].length;
  }
  return tokens;
};

/**
 * Recursive-descent over `or := and (|| and)*`, `and := unary (&& unary)*`,
 * `unary := !unary | (expr) | ident (==|!= literal)?`. Leftover tokens or a
 * parse gap make the whole clause false — an unparseable `when` disables the
 * binding rather than misfiring.
 */
export const evaluateWhen = (expression: string, context: WhenContext): boolean => {
  const tokens = tokenizeWhen(expression);
  if (tokens === null || tokens.length === 0) {
    return expression.trim().length === 0 ? true : false;
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  const parsePrimary = (): boolean | string | null => {
    const token = take();
    if (token === undefined) {
      return null;
    }
    if (token.kind === "op" && token.value === "(") {
      const value = parseOr();
      const close = take();
      return close?.kind === "op" && close.value === ")" ? value : null;
    }
    if (token.kind === "ident") {
      const next = peek();
      if (next?.kind === "op" && (next.value === "==" || next.value === "!=")) {
        take();
        const literal = take();
        if (literal === undefined || (literal.kind !== "string" && literal.kind !== "ident")) {
          return null;
        }
        const actual = context(token.value);
        const equal = actual !== undefined && String(actual) === literal.value;
        return next.value === "==" ? equal : !equal;
      }
      const value = context(token.value);
      return typeof value === "string" ? value : value === true;
    }
    if (token.kind === "string") {
      return token.value;
    }
    return null;
  };

  const parseUnary = (): boolean | string | null => {
    const token = peek();
    if (token?.kind === "op" && token.value === "!") {
      take();
      const value = parseUnary();
      return value === null
        ? null
        : !(value === true || (typeof value === "string" && value.length > 0));
    }
    return parsePrimary();
  };

  const truthy = (value: boolean | string | null): boolean =>
    value === true || (typeof value === "string" && value.length > 0);

  const parseAnd = (): boolean | string | null => {
    let left = parseUnary();
    while (peek()?.kind === "op" && (peek() as { value: string }).value === "&&") {
      take();
      const right = parseUnary();
      left = left === null || right === null ? null : truthy(left) && truthy(right);
    }
    return left;
  };

  const parseOr = (): boolean | string | null => {
    let left = parseAnd();
    while (peek()?.kind === "op" && (peek() as { value: string }).value === "||") {
      take();
      const right = parseAnd();
      left = left === null || right === null ? null : truthy(left) || truthy(right);
    }
    return left;
  };

  const value = parseOr();
  return index === tokens.length && value !== null ? truthy(value) : false;
};

// ── Resolution ─────────────────────────────────────────────────

/**
 * The command a keypress dispatches: the first binding whose shortcut matches
 * and whose `when` clause holds. First match wins, so user bindings listed
 * ahead of defaults shadow them.
 */
export const resolveKeybinding = (
  keybindings: ReadonlyArray<Keybinding>,
  event: ShortcutEvent,
  context: WhenContext,
  modKey: ModKey,
): Keybinding | null => {
  for (const binding of keybindings) {
    const parsed = parseShortcut(binding.shortcut);
    if (parsed === null || !matchShortcut(parsed, event, modKey)) {
      continue;
    }
    if (binding.when !== undefined && !evaluateWhen(binding.when, context)) {
      continue;
    }
    return binding;
  }
  return null;
};

/**
 * Bindings sharing a shortcut inside the same `when` scope — the editor flags
 * these as conflicts because only the first can ever fire.
 */
export const findKeybindingConflicts = (
  keybindings: ReadonlyArray<Keybinding>,
): ReadonlyArray<ReadonlyArray<Keybinding>> => {
  const groups = new Map<string, Array<Keybinding>>();
  for (const binding of keybindings) {
    const parsed = parseShortcut(binding.shortcut);
    if (parsed === null) {
      continue;
    }
    const key = `${binding.when ?? ""}${binding.shortcut.toLowerCase()}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [binding]);
    } else {
      group.push(binding);
    }
  }
  return [...groups.values()].filter((group) => group.length > 1);
};
