/**
 * The keybinding matcher: parses the `Keybinding.shortcut` notation
 * (`Mod+Shift+B`, `Escape`), matches it against a `KeyboardEvent`-shaped value,
 * and evaluates the optional `when` clause against caller-supplied context.
 *
 * `Mod` is the platform modifier — Meta on macOS/iOS, Ctrl elsewhere — so one
 * stored binding works on every keyboard. `Cmd` and `Meta` are aliases of it,
 * so a table written as `Cmd+…` keeps working. `Ctrl` means the physical
 * Control key everywhere. Matching is exact on modifiers: `Escape` does not
 * fire on `Shift+Escape`, and `Mod+K` does not fire on `Mod+Alt+K`.
 *
 * With Alt or Shift held, `event.key` is often not the key's own character —
 * macOS Option+R reports `®`, Shift+[ reports `{` — so a chord with Alt or
 * Shift also matches on the key `event.code` names. A press where AltGr is
 * typing a character (Ctrl+Alt on a European layout) never matches anything.
 *
 * `when` is a small expression over context flags: `composerFocus`,
 * `!composerFocus`, `a && b`, `a || b`, parentheses, and `flag == "value"`.
 * Unknown flags evaluate as false, so a binding for a context that does not
 * exist yet is simply inert. While focus is in a text field (`inputFocus`),
 * only chords that cannot be typing fire — see `firesInTextField`.
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

/** Keys that only modify — a press of one alone is not a chord yet. */
const MODIFIER_KEYS = new Set([...MODIFIER_TOKENS, "altgraph", "os", "super", "hyper", "fn"]);

const normaliseKey = (token: string): string | null => {
  const lower = token.toLowerCase();
  const aliased = KEY_ALIASES[lower] ?? lower;
  return MODIFIER_TOKENS.has(aliased) ? null : aliased;
};

/**
 * `Mod+Shift+B` → `{ key: "b", mod: true, shift: true }`. `Cmd` and `Meta`
 * parse as `Mod`. Returns null when the chord has no non-modifier key — a
 * bare `Mod` is not a shortcut.
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
    if (lower === "mod" || lower === "cmd" || lower === "meta") {
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
  /** The physical key (`KeyR`, `BracketLeft`), independent of layout and modifiers. */
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** Only ever asked about `AltGraph`; a DOM or React keyboard event fits. */
  readonly getModifierState?: (key: "AltGraph") => boolean;
}

const eventKey = (event: ShortcutEvent): string => {
  const lower = event.key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
};

const CODE_KEYS: Readonly<Record<string, string>> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

/** `KeyR` → `r`, `Digit1` → `1`, `BracketLeft` → `[`; anything else is unknown. */
const keyFromCode = (code: string | undefined): string | undefined => {
  if (code === undefined) {
    return undefined;
  }
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter !== null) {
    return letter[1]!.toLowerCase();
  }
  const digit = /^Digit(\d)$/u.exec(code);
  return digit !== null ? digit[1]! : CODE_KEYS[code];
};

/**
 * The key `event.code` names, when `event.key` is not a plain letter or digit
 * and so may be what a modifier turned the key into. A reported letter or
 * digit is trusted as is: on AZERTY the key at `KeyQ` types `a`, and a chord
 * on A must not fire on Q.
 */
const codeFallbackKey = (event: ShortcutEvent): string | undefined =>
  /^[a-z0-9]$/u.test(eventKey(event)) ? undefined : keyFromCode(event.code);

/**
 * Exact-modifier match. `mod` is the platform modifier — `metaKey` on macOS,
 * `ctrlKey` elsewhere — while `ctrl` always means the physical Control key.
 * Undeclared modifiers must not be held: `Mod+K` does not fire on
 * `Mod+Alt+K`, and `Escape` does not fire on `Shift+Escape`. A chord with Alt
 * or Shift also matches on the key `event.code` names, so `Mod+Shift+[`
 * matches a macOS press reporting `{` and `Mod+Alt+R` one reporting `®`.
 */
export const matchShortcut = (
  shortcut: ParsedShortcut,
  event: ShortcutEvent,
  modKey: ModKey,
): boolean => {
  const keyMatches =
    eventKey(event) === shortcut.key ||
    ((shortcut.alt || shortcut.shift) && codeFallbackKey(event) === shortcut.key);
  if (!keyMatches) {
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

/** What Shift turns a US key into, so Ctrl+Alt+Shift+[ typing `{` is not AltGr. */
const US_SHIFTED: Readonly<Record<string, string>> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
};

const US_UNSHIFTED: ReadonlyMap<string, string> = new Map(
  Object.entries(US_SHIFTED).map(([own, shifted]): [string, string] => [shifted, own]),
);

/**
 * The key a US Shift turns into `key`: `{` → `[`, `?` → `/`, `+` → `=`. Any
 * other key is its own. With Shift held the matcher also matches on the
 * physical key, so `Mod+Shift+{` and `Mod+Shift+[` fire on the same press;
 * this is how the keymap checks tell that they are one chord.
 */
export const unshiftedKey = (key: string): string => US_UNSHIFTED.get(key) ?? key;

/**
 * True when the press is AltGr typing a character rather than a chord: the
 * event reports the AltGraph modifier, or — off macOS, where AltGr arrives as
 * Ctrl+Alt — Ctrl and Alt are held and the key typed a printable character
 * that is not the key's own. AltGr+C typing `ć` must not fire `Mod+Alt+C`.
 */
export const isAltGraphTyping = (event: ShortcutEvent, modKey: ModKey): boolean => {
  if (event.getModifierState?.("AltGraph") === true) {
    return true;
  }
  if (modKey === "meta" || !event.ctrlKey || !event.altKey || event.code === undefined) {
    return false;
  }
  const typed = event.key;
  if ([...typed].length !== 1 || /\s/u.test(typed)) {
    return false;
  }
  const own = keyFromCode(event.code);
  const lower = typed.toLowerCase();
  return own !== lower && !(event.shiftKey && own !== undefined && US_SHIFTED[own] === typed);
};

const keyLabel = (key: string): string =>
  key === " "
    ? "Space"
    : key === "+"
      ? "Plus"
      : key.length === 1
        ? key.toUpperCase()
        : `${key[0]!.toUpperCase()}${key.slice(1)}`;

/**
 * Turns a captured `KeyboardEvent` back into `Mod+Shift+B` notation for the
 * editor's record field. Modifier-only presses return null so holding Mod
 * while deciding does not commit anything. With Alt held, or Shift on a key
 * that is not a letter or digit, the key `event.code` names is written, so the
 * recorder stores `Mod+Alt+R` rather than `Mod+Alt+®`.
 */
export const formatEventAsShortcut = (event: ShortcutEvent, modKey: ModKey): string | null => {
  const typed = eventKey(event);
  if (MODIFIER_KEYS.has(typed)) {
    return null;
  }
  const key = (event.altKey || event.shiftKey ? codeFallbackKey(event) : undefined) ?? typed;
  const parts: Array<string> = [];
  const modPressed = modKey === "meta" ? event.metaKey : event.ctrlKey;
  const otherPressed = modKey === "meta" ? event.ctrlKey : event.metaKey;
  if (modPressed) {
    parts.push("Mod");
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
  parts.push(keyLabel(key));
  return parts.join("+");
};

// ── `when` parsing and evaluation ──────────────────────────────

/** The values a `when` clause may read: flags, or strings for `==`/`!=`. */
export type WhenContext = (name: string) => boolean | string | undefined;

/** A parsed `when` clause. An empty clause is `{ kind: "const", value: true }`. */
export type WhenNode =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "flag"; readonly name: string }
  | {
      readonly kind: "compare";
      readonly name: string;
      readonly value: string;
      readonly equal: boolean;
    }
  | { readonly kind: "not"; readonly operand: WhenNode }
  | { readonly kind: "and" | "or"; readonly left: WhenNode; readonly right: WhenNode };

type Token =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "op"; readonly value: "!" | "&&" | "||" | "(" | ")" | "==" | "!=" };

const tokenizeWhen = (source: string): ReadonlyArray<Token> | null => {
  const tokens: Array<Token> = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const pair = source.slice(index, index + 2);
    if (/\s/u.test(char)) {
      index += 1;
    } else if (pair === "!=" || pair === "&&" || pair === "||" || pair === "==") {
      tokens.push({ kind: "op", value: pair });
      index += 2;
    } else if (char === "(" || char === ")" || char === "!") {
      tokens.push({ kind: "op", value: char });
      index += 1;
    } else if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) {
        return null;
      }
      tokens.push({ kind: "string", value: source.slice(index + 1, end) });
      index = end + 1;
    } else {
      const ident = /^[A-Za-z_][\w-]*/u.exec(source.slice(index));
      if (ident === null) {
        return null;
      }
      tokens.push({ kind: "ident", value: ident[0] });
      index += ident[0].length;
    }
  }
  return tokens;
};

/**
 * Recursive descent over `or := and (|| and)*`, `and := unary (&& unary)*`,
 * `unary := !unary | (or) | ident (==|!= literal)? | "string"`. Returns null
 * for anything that does not parse — leftover tokens included — and the
 * constant true for an empty clause.
 */
export const parseWhen = (expression: string): WhenNode | null => {
  const tokens = tokenizeWhen(expression);
  if (tokens === null) {
    return null;
  }
  if (tokens.length === 0) {
    return { kind: "const", value: true };
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const isOp = (token: Token | undefined, value: string): boolean =>
    token?.kind === "op" && token.value === value;

  const parsePrimary = (): WhenNode | null => {
    const token = take();
    if (token === undefined) {
      return null;
    }
    if (isOp(token, "(")) {
      const inner = parseOr();
      return isOp(take(), ")") ? inner : null;
    }
    if (token.kind === "string") {
      return { kind: "const", value: token.value.length > 0 };
    }
    if (token.kind !== "ident") {
      return null;
    }
    const next = peek();
    if (isOp(next, "==") || isOp(next, "!=")) {
      take();
      const literal = take();
      if (literal === undefined || literal.kind === "op") {
        return null;
      }
      return { kind: "compare", name: token.value, value: literal.value, equal: isOp(next, "==") };
    }
    return { kind: "flag", name: token.value };
  };

  const parseUnary = (): WhenNode | null => {
    if (isOp(peek(), "!")) {
      take();
      const operand = parseUnary();
      return operand === null ? null : { kind: "not", operand };
    }
    return parsePrimary();
  };

  const parseBinary = (
    kind: "and" | "or",
    op: string,
    parseOperand: () => WhenNode | null,
  ): WhenNode | null => {
    let left = parseOperand();
    while (left !== null && isOp(peek(), op)) {
      take();
      const right = parseOperand();
      left = right === null ? null : { kind, left, right };
    }
    return left;
  };

  const parseAnd = () => parseBinary("and", "&&", parseUnary);
  const parseOr = (): WhenNode | null => parseBinary("or", "||", parseAnd);

  const node = parseOr();
  return index === tokens.length ? node : null;
};

/**
 * A flag is true when the context says `true` or a non-empty string;
 * `name == "v"` compares the context value's string form, and a missing value
 * equals nothing.
 */
export const evaluateWhenNode = (node: WhenNode, context: WhenContext): boolean => {
  switch (node.kind) {
    case "const":
      return node.value;
    case "flag": {
      const value = context(node.name);
      return value === true || (typeof value === "string" && value.length > 0);
    }
    case "compare": {
      const actual = context(node.name);
      const equal = actual !== undefined && String(actual) === node.value;
      return node.equal ? equal : !equal;
    }
    case "not":
      return !evaluateWhenNode(node.operand, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
};

/**
 * Evaluates a clause. An empty clause is true; an unparseable one is false —
 * it disables the binding rather than misfiring.
 */
export const evaluateWhen = (expression: string, context: WhenContext): boolean => {
  const node = parseWhen(expression);
  return node !== null && evaluateWhenNode(node, context);
};

// ── The text-field rule ────────────────────────────────────────

/**
 * The context keys that put focus in a text field. A clause that cannot hold
 * without one of them opts a binding into text fields. `browserFocus` is not
 * one: the browser pane has an address bar, but most of it is not a field.
 */
const TEXT_FOCUS_KEYS: ReadonlySet<string> = new Set([
  "inputFocus",
  "composerFocus",
  "terminalFocus",
]);

type WhenLeaf = Extract<WhenNode, { kind: "flag" | "compare" }>;

/** Evaluates a clause with each flag or comparison answered by `leaf`. */
const evaluateLeaves = (node: WhenNode, leaf: (node: WhenLeaf) => boolean): boolean => {
  switch (node.kind) {
    case "const":
      return node.value;
    case "flag":
    case "compare":
      return leaf(node);
    case "not":
      return !evaluateLeaves(node.operand, leaf);
    case "and":
      return evaluateLeaves(node.left, leaf) && evaluateLeaves(node.right, leaf);
    case "or":
      return evaluateLeaves(node.left, leaf) || evaluateLeaves(node.right, leaf);
  }
};

/** A comparison is its own atom, true when it holds: `x == "v"`, never `x != "v"`. */
const leafAtom = (node: WhenLeaf): string =>
  node.kind === "flag" ? node.name : `${node.name}==${JSON.stringify(node.value)}`;

const leafAtoms = (node: WhenNode, into: Set<string>): Set<string> => {
  switch (node.kind) {
    case "const":
      return into;
    case "flag":
    case "compare":
      return TEXT_FOCUS_KEYS.has(node.name) ? into : into.add(leafAtom(node));
    case "not":
      return leafAtoms(node.operand, into);
    case "and":
    case "or":
      return leafAtoms(node.right, leafAtoms(node.left, into));
  }
};

/** Beyond this many other atoms the check gives up and does not opt in. */
const MAX_OTHER_ATOMS = 12;

/**
 * True when the clause cannot hold unless focus is in a text field: it is
 * false under every assignment in which `inputFocus`, `composerFocus` and
 * `terminalFocus` are all false. `composerFocus` and `inputFocus && x` need a
 * text field; `!terminalFocus`, `threadOpen && !browserFocus` and
 * `x || composerFocus` do not, so naming a focus key is not enough. Every
 * other flag, and every `x == "v"`, is tried both ways.
 */
export const whenNeedsTextFocus = (when: string | undefined): boolean => {
  const node = when === undefined ? null : parseWhen(when);
  if (node === null) {
    return false;
  }
  const atoms = [...leafAtoms(node, new Set())];
  if (atoms.length > MAX_OTHER_ATOMS) {
    return false;
  }
  for (let mask = 0; mask < 1 << atoms.length; mask += 1) {
    const holds = evaluateLeaves(node, (leaf) => {
      if (TEXT_FOCUS_KEYS.has(leaf.name)) {
        // The focus key is false here; a comparison reads it as `false`.
        return leaf.kind === "flag" ? false : (leaf.value === "false") === leaf.equal;
      }
      const value = (mask & (1 << atoms.indexOf(leafAtom(leaf)))) !== 0;
      return leaf.kind === "compare" && !leaf.equal ? !value : value;
    });
    if (holds) {
      return false;
    }
  }
  return true;
};

const FUNCTION_KEY = /^f(?:[1-9]|1\d|2[0-4])$/u;

/**
 * Whether a binding may fire while focus is in a text field. A chord with Mod
 * or Ctrl, Escape, or an F-key cannot be typing, so it may; anything else —
 * a plain key, Shift+key, Alt+key, Tab, Enter, an arrow — only when its `when`
 * clause cannot hold outside a text field (`whenNeedsTextFocus`), and so says
 * which field it means to act in.
 */
export const firesInTextField = (shortcut: ParsedShortcut, when: string | undefined): boolean =>
  shortcut.mod ||
  shortcut.ctrl ||
  shortcut.key === "escape" ||
  FUNCTION_KEY.test(shortcut.key) ||
  whenNeedsTextFocus(when);

// ── Resolution ─────────────────────────────────────────────────

/**
 * The command a keypress dispatches: the first binding whose shortcut matches
 * and whose `when` clause holds. First match wins, so user bindings listed
 * ahead of defaults shadow them. AltGr typing resolves to nothing, and while
 * `inputFocus` is true only bindings `firesInTextField` allows are considered.
 */
export const resolveKeybinding = (
  keybindings: ReadonlyArray<Keybinding>,
  event: ShortcutEvent,
  context: WhenContext,
  modKey: ModKey,
): Keybinding | null => {
  if (isAltGraphTyping(event, modKey)) {
    return null;
  }
  const typing = context("inputFocus") === true;
  for (const binding of keybindings) {
    const parsed = parseShortcut(binding.shortcut);
    if (parsed === null || !matchShortcut(parsed, event, modKey)) {
      continue;
    }
    if (typing && !firesInTextField(parsed, binding.when)) {
      continue;
    }
    if (binding.when !== undefined && !evaluateWhen(binding.when, context)) {
      continue;
    }
    return binding;
  }
  return null;
};
