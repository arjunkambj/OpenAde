/**
 * The keybindings editor's draft, as data. The draft is the effective table —
 * the shipped defaults with the user's overrides layered on — so it is exactly
 * what the listener would resolve against once saved; Save posts
 * `diffKeymap(DEFAULT_KEYBINDINGS, draft)`.
 *
 * Every edit is made per command and then normalised: the draft is diffed
 * against the defaults and resolved again (`normalizeDraft`), so the rows sit
 * in the order they will have after a save and reload — override rows first —
 * and a command edited back to its defaults stops being an override.
 *
 * Pure, so it is tested without a DOM; the editor is
 * `@/components/keybindings/keybindings-editor`.
 */

import { parseShortcut, parseWhen, type ModKey } from "@OpenAde/client-runtime/keybindings";
import { findKeybindingConflicts, reservedChordReason } from "@OpenAde/client-runtime/keymap";
import {
  DEFAULT_KEYBINDINGS,
  diffKeymap,
  isUnbindRow,
  resolveKeymap,
} from "@OpenAde/contracts/keybindings";
import type { Keybinding } from "@OpenAde/contracts/settings";

type Draft = ReadonlyArray<Keybinding>;

/** The draft as it will be after a save and reload. */
export const normalizeDraft = (draft: Draft): Draft =>
  resolveKeymap(DEFAULT_KEYBINDINGS, diffKeymap(DEFAULT_KEYBINDINGS, draft));

/** What Save posts: the overrides that turn the defaults into `draft`. */
export const draftOverrides = (draft: Draft): ReadonlyArray<Keybinding> =>
  diffKeymap(DEFAULT_KEYBINDINGS, draft);

/** Whether two drafts would store the same overrides. */
export const sameDraft = (a: Draft, b: Draft): boolean => {
  const left = draftOverrides(a);
  const right = draftOverrides(b);
  return (
    left.length === right.length &&
    left.every(
      (row, i) =>
        row.command === right[i]?.command &&
        row.shortcut === right[i]?.shortcut &&
        row.when === right[i]?.when,
    )
  );
};

/** The commands whose rows differ from their defaults — the "Modified" ones. */
export const modifiedCommands = (draft: Draft): ReadonlySet<string> =>
  new Set(
    draftOverrides(draft).map((row) => (isUnbindRow(row) ? row.command.slice(1) : row.command)),
  );

/** A command's rows, each with its index in the draft. */
export const commandBindings = (
  draft: Draft,
  command: string,
): ReadonlyArray<{ readonly binding: Keybinding; readonly index: number }> =>
  draft.flatMap((binding, index) => (binding.command === command ? [{ binding, index }] : []));

/** The commands the draft binds that `known` does not list, in draft order. */
export const unknownCommands = (
  draft: Draft,
  known: ReadonlySet<string>,
): ReadonlyArray<string> => [
  ...new Set(draft.map((row) => row.command).filter((command) => !known.has(command))),
];

/**
 * Change the chord or the clause of the row at `index`. An empty clause
 * means "always", so it is stored as no clause.
 */
export const patchBinding = (
  draft: Draft,
  index: number,
  patch: { readonly shortcut?: string; readonly when?: string },
): Draft =>
  normalizeDraft(
    draft.map((row, i) => {
      if (i !== index) {
        return row;
      }
      const shortcut = patch.shortcut ?? row.shortcut;
      const when = "when" in patch ? patch.when : row.when;
      return when === undefined || when.trim() === ""
        ? { command: row.command, shortcut }
        : { command: row.command, shortcut, when };
    }),
  );

/** Drop the row at `index`; a default command left with none becomes unbound. */
export const removeBinding = (draft: Draft, index: number): Draft =>
  normalizeDraft(draft.filter((_, i) => i !== index));

/** Bind `command` to one more chord, after its existing rows; a chord it already has is a no-op. */
export const addBinding = (draft: Draft, command: string, shortcut: string): Draft => {
  if (
    draft.some(
      (row) => row.command === command && row.shortcut === shortcut && row.when === undefined,
    )
  ) {
    return draft;
  }
  const last = draft.findLastIndex((row) => row.command === command);
  const row: Keybinding = { command, shortcut };
  return normalizeDraft(
    last === -1 ? [...draft, row] : [...draft.slice(0, last + 1), row, ...draft.slice(last + 1)],
  );
};

/** Put `command` back on its shipped rows; a command with no default goes away. */
export const resetCommand = (draft: Draft, command: string): Draft =>
  resolveKeymap(
    DEFAULT_KEYBINDINGS,
    draftOverrides(draft).filter((row) => row.command !== command && row.command !== `-${command}`),
  );

/** Every command back on its shipped rows: no overrides at all. */
export const resetAll = (): Draft => resolveKeymap(DEFAULT_KEYBINDINGS, []);

export interface BindingIssues {
  /** Other commands bound to the same keys in a context that can overlap. */
  readonly conflicts: ReadonlyArray<{ readonly command: string; readonly wins: boolean }>;
  /** Why the system or the shell owns this chord, when it does. */
  readonly reserved: string | null;
  readonly invalidShortcut: boolean;
  readonly invalidWhen: boolean;
}

/**
 * What is wrong with each row of the draft, on `platform`, aligned with the
 * draft by index. A conflict is another command's row on the same physical
 * chord whose context can hold at the same time (`findKeybindingConflicts`);
 * `wins` says whether this row is the one that fires there, which is the one
 * that comes first in the table.
 */
export const draftIssues = (draft: Draft, platform: ModKey): ReadonlyArray<BindingIssues> => {
  const position = new Map(draft.map((row, index) => [row, index]));
  const conflicts = draft.map((): Array<{ command: string; wins: boolean }> => []);
  for (const conflict of findKeybindingConflicts(draft, platform)) {
    const first = position.get(conflict.first);
    const second = position.get(conflict.second);
    if (first !== undefined && second !== undefined) {
      conflicts[first]!.push({ command: conflict.second.command, wins: true });
      conflicts[second]!.push({ command: conflict.first.command, wins: false });
    }
  }
  return draft.map((row, index) => ({
    conflicts: conflicts[index]!,
    reserved: reservedChordReason(row.shortcut, platform, row.when),
    invalidShortcut: parseShortcut(row.shortcut) === null,
    invalidWhen: parseWhen(row.when ?? "") === null,
  }));
};
