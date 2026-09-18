/**
 * `fs.browse`: one directory's subfolders, for the folder picker.
 *
 * The whole surface is deliberately narrow. It lists directories and nothing
 * else — no files, no recursion, no search — because the only question it
 * answers is "which folder do you want", and every capability beyond that is a
 * capability a remote client would also get.
 *
 * Four rules the tests pin:
 *
 *  - **Absolute paths only.** A relative path would be resolved against the
 *    server process's working directory, which is a directory the user never
 *    chose and cannot see. It is refused rather than guessed at.
 *  - **The answer names the real path.** Every listing reports the
 *    symlink-resolved path the server actually read, so the breadcrumb the
 *    picker builds addresses the same directory on the next call instead of
 *    walking a chain of links.
 *  - **A symlinked entry never gets a git badge.** Deciding `isGitRepo` means
 *    looking for `.git` *inside* the entry, and for a link that lookup leaves
 *    the directory that was asked for. The entry is still listed when it points
 *    at a directory; it simply reports `false`.
 *  - **An unreadable entry is absent, not fatal.** One subdirectory the user
 *    cannot stat must not turn the whole listing into an error — the folder it
 *    sits in is usually still the one they were looking for.
 *
 * No extra authorization: the RPC is already authenticated and the server runs
 * as the user whose disk this is, so it may see what they may see. What it must
 * not do is hand back *why* in the operating system's words — an errno, a cause
 * chain, a path the client never named — so every failure is flattened into one
 * of `FsBrowseFailure` with a message written for a person.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import type { Dirent } from "node:fs";

import type { FsEntry, FsListing } from "@OpenAde/contracts/rpc";
import { FS_BROWSE_ENTRY_LIMIT, FsBrowseError } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DirectoryBrowser } from "../rpc/services";

/** What the picker is told, per failure. Never the operating system's wording. */
const MESSAGES = {
  "not-absolute": "Enter an absolute path, starting at the root of the disk.",
  "not-found": "That folder does not exist.",
  "not-a-directory": "That path is a file, not a folder.",
  "permission-denied": "That folder cannot be opened.",
  internal: "That folder could not be read.",
} as const;

const fail = (reason: keyof typeof MESSAGES, path: string) =>
  new FsBrowseError({ reason, path, message: MESSAGES[reason] });

/** A Node errno, as one of the four answers the picker can act on. */
const reasonOf = (error: unknown): keyof typeof MESSAGES => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code: unknown }).code)
      : "";
  switch (code) {
    case "ENOENT":
      return "not-found";
    case "ENOTDIR":
      return "not-a-directory";
    case "EACCES":
    case "EPERM":
      return "permission-denied";
    default:
      return "internal";
  }
};

/**
 * Case-insensitive, then exact — the order a person reads a folder in, and
 * stable whatever locale the server happens to run under (`localeCompare`
 * is not: the same two names sort differently under two ICU builds, and the
 * picker's keyboard navigation would drift with it).
 */
const byName = (left: string, right: string): number => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
};

/** Does this directory hold a `.git`? A failure answers "no", never throws. */
const looksLikeRepository = async (path: string): Promise<boolean> => {
  try {
    await stat(nodePath.join(path, ".git"));
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether one entry belongs in the listing, and whether its git badge may be
 * computed. A plain directory: yes to both. A symlink: listed when it resolves
 * to a directory, never badged. Anything else, and anything that cannot be
 * stat'd at all: absent.
 */
const classify = async (
  directory: string,
  entry: Dirent,
): Promise<{ readonly name: string; readonly real: boolean } | null> => {
  if (entry.isDirectory()) {
    return { name: entry.name, real: true };
  }
  if (!entry.isSymbolicLink()) {
    return null;
  }
  try {
    const target = await stat(nodePath.join(directory, entry.name));
    return target.isDirectory() ? { name: entry.name, real: false } : null;
  } catch {
    return null;
  }
};

const collect = async (
  directory: string,
  showHidden: boolean,
  limit: number,
): Promise<FsListing> => {
  const dirents = await readdir(directory, { withFileTypes: true });
  const visible = dirents.filter((entry) => showHidden || !entry.name.startsWith("."));
  const classified = await Promise.all(visible.map((entry) => classify(directory, entry)));
  const directories = classified
    .filter((entry): entry is { readonly name: string; readonly real: boolean } => entry !== null)
    .sort((left, right) => byName(left.name, right.name));
  // Sorted first, then capped, then badged: the `.git` lookups are one stat per
  // row and only the rows that survive the cap are ever worth doing.
  const kept = directories.slice(0, limit);
  const entries = await Promise.all(
    kept.map(async (entry): Promise<FsEntry> => {
      const path = nodePath.join(directory, entry.name);
      return {
        name: entry.name,
        path,
        isGitRepo: entry.real ? await looksLikeRepository(path) : false,
      };
    }),
  );
  const parent = nodePath.dirname(directory);
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
    truncated: directories.length > kept.length,
  };
};

/** @public What one `fs.browse` call may be asked for. */
export interface BrowseRequest {
  /** Absolute. Omitted means the server user's home directory. */
  readonly path?: string | undefined;
  readonly showHidden?: boolean | undefined;
  /** The entry cap. Only a test lowers it; the RPC always uses the contract's. */
  readonly limit?: number | undefined;
}

/**
 * @public One directory, or the one failure the picker can act on. Exported for
 * the tests, which drive it against a temporary tree without a layer.
 */
export const browseDirectory = (
  request: BrowseRequest = {},
): Effect.Effect<FsListing, FsBrowseError> =>
  Effect.gen(function* () {
    const requested = request.path === undefined ? homedir() : request.path;
    if (!nodePath.isAbsolute(requested)) {
      return yield* fail("not-absolute", requested);
    }
    // `realpath` is what turns the client's string into the path this server
    // will keep calling itself: it settles `..`, a trailing slash and every
    // link in the chain in one syscall, and it is also the existence check.
    const real = yield* Effect.tryPromise({
      try: () => realpath(requested),
      catch: (error) => fail(reasonOf(error), requested),
    });
    const info = yield* Effect.tryPromise({
      try: () => stat(real),
      catch: (error) => fail(reasonOf(error), requested),
    });
    if (!info.isDirectory()) {
      return yield* fail("not-a-directory", requested);
    }
    return yield* Effect.tryPromise({
      try: () => collect(real, request.showHidden === true, request.limit ?? FS_BROWSE_ENTRY_LIMIT),
      catch: (error) => fail(reasonOf(error), requested),
    });
  });

/** @public The real `DirectoryBrowser`. Wired in `boot.ts`. */
export const layer = Layer.succeed(
  DirectoryBrowser,
  DirectoryBrowser.of({
    browse: (input) =>
      browseDirectory({
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.showHidden === undefined ? {} : { showHidden: input.showHidden }),
      }),
  }),
);
