/**
 * The folder picker's state, as values.
 *
 * Everything the dialog decides — which directory it is asking the server for,
 * what the path field shows, which row the keyboard is on, which children a
 * half-typed path could mean, and what a key press means — is a function here,
 * so it is testable without a DOM (the renderer's vitest project runs in
 * `node`, and this repository has no jsdom).
 *
 * Two rules the shapes exist to keep:
 *
 * 1. **The browsed path and the typed text are not the same thing.** `path` is
 *    the request; `draft` is the field. A `draft` of `null` means "the field is
 *    showing the directory itself", which is why clearing the field is a state
 *    the picker can tell apart from having just navigated — and why Backspace
 *    on an empty field can mean "go up" without stealing an ordinary edit.
 * 2. **Paths come back from the server.** The parent of a directory and its
 *    normalized spelling are in the listing, so nothing here re-implements
 *    path arithmetic. The one exception is splitting the *typed* text into "a
 *    directory and a prefix" for completion, which has to happen before any
 *    server has seen it.
 */

import type { FsEntry, FsListing } from "@OpenAde/contracts/rpc";

/** Where the picker is looking, and what the field is showing while it does. */
export interface PickerLocation {
  /** The directory to list. `null` asks the server for its own home. */
  readonly path: string | null;
  /** The typed path, or `null` while the field simply shows `path`. */
  readonly draft: string | null;
  /** The highlighted row, an index into the listing's entries. */
  readonly cursor: number;
}

/**
 * Where to open. An absolute path the caller already has (the field the user
 * was typing into) is browsed directly; anything else opens on the server's
 * home, because a relative path is not something this dialog can resolve.
 */
export const initialLocation = (seed: string): PickerLocation => {
  const trimmed = seed.trim();
  return {
    path: trimmed.startsWith("/") ? trimmed : null,
    draft: null,
    cursor: 0,
  };
};

/** Navigate: a new directory, the field following it, the cursor at the top. */
export const movedTo = (path: string): PickerLocation => ({ path, draft: null, cursor: 0 });

/** A keystroke in the path field. The text is the truth from the first one. */
export const typed = (location: PickerLocation, text: string): PickerLocation => ({
  ...location,
  draft: text,
  cursor: 0,
});

/** The row the arrow keys are on, clamped to what the listing actually has. */
export const movedCursor = (
  location: PickerLocation,
  delta: number,
  count: number,
): PickerLocation => {
  if (count === 0) {
    return { ...location, cursor: 0 };
  }
  const next = Math.min(Math.max(location.cursor + delta, 0), count - 1);
  return { ...location, cursor: next };
};

/** The row a pointer landed on, clamped the same way an arrow key is. */
export const cursorOn = (location: PickerLocation, index: number, count: number): PickerLocation =>
  movedCursor({ ...location, cursor: 0 }, index, count);

/**
 * What the path field shows: what was typed, the directory the server answered
 * with, or — while that answer is still coming, or never came — the directory
 * that was asked for. That last fallback is what keeps a path the server just
 * refused in the field, where it can be corrected, instead of emptying it and
 * making the user type the whole thing again.
 *
 * An empty string is a real answer — the user cleared the field — and is not
 * replaced by any of them.
 */
export const fieldValue = (location: PickerLocation, listing: FsListing | null): string =>
  location.draft ?? listing?.path ?? location.path ?? "";

/** The entry the keyboard is on, or `null` for an empty listing. */
export const highlighted = (location: PickerLocation, listing: FsListing | null): FsEntry | null =>
  listing?.entries[location.cursor] ?? null;

/**
 * The typed text split where the last separator is: the directory it names and
 * the prefix inside it. `/Users/dev/co` is `/Users/dev` plus `co`;
 * `/Users/dev/` is `/Users/dev` plus nothing; `/U` is `/` plus `U`.
 *
 * Separators are `/` alone. The server this talks to is the one that answered
 * the listing, and every path in a listing is spelled the way that server
 * spells it — so the only way a backslash reaches here is a Windows path typed
 * by hand, which `fs.browse` is the right place to refuse.
 */
export const splitTypedPath = (text: string): { directory: string; prefix: string } => {
  const cut = text.lastIndexOf("/");
  if (cut < 0) {
    return { directory: "", prefix: text };
  }
  return {
    directory: cut === 0 ? "/" : text.slice(0, cut),
    prefix: text.slice(cut + 1),
  };
};

/** `/Users/dev/` and `/Users/dev` name one directory; `/` stays `/`. */
const withoutTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/u, "") : path;

/**
 * The children of the listed directory a half-typed path could still become.
 *
 * Only ever the *current* directory's own entries: the completion is a shortcut
 * for the rows already on screen, not a second search, so it costs nothing and
 * can never disagree with the list below it. Nothing is offered while the field
 * is merely showing where the picker is (`draft === null`), or once the typed
 * name is complete enough to be one of them exactly.
 */
export const completionsFor = (
  draft: string | null,
  listing: FsListing | null,
): ReadonlyArray<FsEntry> => {
  if (draft === null || listing === null) {
    return [];
  }
  const text = draft.trim();
  if (text === "") {
    return [];
  }
  const { directory, prefix } = splitTypedPath(text);
  if (withoutTrailingSlash(directory) !== withoutTrailingSlash(listing.path)) {
    return [];
  }
  if (prefix === "") {
    return [];
  }
  const wanted = prefix.toLowerCase();
  return listing.entries.filter(
    (entry) => entry.name.toLowerCase().startsWith(wanted) && entry.name !== prefix,
  );
};

/** One clickable segment of the current path. */
export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/**
 * The current directory as a trail of the directories above it, root first.
 * Built from the server's own spelling of the path, so every crumb is a path
 * `fs.browse` will accept back.
 */
export const breadcrumbFor = (path: string): ReadonlyArray<Crumb> => {
  const crumbs: Array<Crumb> = [{ label: "/", path: "/" }];
  let walked = "";
  for (const segment of path.split("/")) {
    if (segment === "") {
      continue;
    }
    walked = `${walked}/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
};

/**
 * What "Use this folder" should do right now.
 *
 * The field and the button used to disagree. The field renders `fieldValue`,
 * which is the typed draft while there is one; the button returned
 * `listing.path`, the directory of the last successful listing. Typing a path
 * only changes what is browsed once Enter navigates to it — so between typing
 * and Enter the button handed back a directory the user was no longer looking
 * at, and the caller created a project on the wrong root.
 *
 * So a pending draft navigates instead of confirming: the picker goes where the
 * field says, and the next press confirms what it then shows. A draft that is
 * only a different spelling of the listed directory (a trailing slash) is the
 * same place, and confirms.
 */
export type PickerConfirm =
  | { readonly kind: "pick"; readonly path: string }
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "none" };

export const confirmAction = (
  location: PickerLocation,
  listing: FsListing | null,
): PickerConfirm => {
  const draft = (location.draft ?? "").trim();
  if (draft !== "" && (listing === null || withoutTrailingSlash(draft) !== listing.path)) {
    return { kind: "navigate", path: draft };
  }
  return listing === null ? { kind: "none" } : { kind: "pick", path: listing.path };
};

/** What a key press means, given where the focus is. */
export type PickerKeyAction =
  | "cursor-up"
  | "cursor-down"
  | "descend"
  | "up"
  | "navigate-typed"
  | null;

/**
 * The keyboard map, in one place.
 *
 * Escape is deliberately absent: the dialog primitive closes on it already, and
 * a second handler here would either double-fire or quietly diverge from every
 * other dialog in the app.
 */
export const pickerKeyAction = (input: {
  readonly key: string;
  /** The event came from the path field rather than the list. */
  readonly inPathField: boolean;
  /** The path field is showing nothing at all. */
  readonly draftEmpty: boolean;
}): PickerKeyAction => {
  if (input.key === "ArrowDown") {
    return "cursor-down";
  }
  if (input.key === "ArrowUp") {
    return "cursor-up";
  }
  if (input.key === "Enter") {
    return input.inPathField ? "navigate-typed" : "descend";
  }
  if (input.key === "Backspace") {
    // In the field this is an ordinary edit unless there is nothing left to
    // edit; in the list there is no text to delete, so it is always "up".
    return !input.inPathField || input.draftEmpty ? "up" : null;
  }
  return null;
};
