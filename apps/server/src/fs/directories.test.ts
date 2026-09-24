/**
 * `fs.browse` against a real temporary tree: what it lists, what it refuses,
 * and the three things it must never do — follow a link out of the directory
 * to badge it, fail a whole listing over one unreadable entry, or tell the
 * client anything the operating system said.
 */
import { describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";

import { browseDirectory } from "./Directories";

/** A scratch tree: two folders, a repository, a file, and a dot-folder. */
const makeTree = () => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "poseidon-browse-test-"));
  mkdirSync(nodePath.join(root, "zebra"));
  mkdirSync(nodePath.join(root, "Alpha"));
  mkdirSync(nodePath.join(root, "repo", ".git"), { recursive: true });
  mkdirSync(nodePath.join(root, ".hidden"));
  writeFileSync(nodePath.join(root, "notes.txt"), "not a folder\n");
  return root;
};

const names = (listing: { readonly entries: ReadonlyArray<{ readonly name: string }> }) =>
  listing.entries.map((entry) => entry.name);

describe("browseDirectory", () => {
  it.effect("lists subfolders only, case-insensitively sorted", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const listing = yield* browseDirectory({ path: root });
      expect(names(listing)).toEqual(["Alpha", "repo", "zebra"]);
      expect(listing.truncated).toBe(false);
      expect(listing.entries[0]?.path).toBe(nodePath.join(listing.path, "Alpha"));
    }),
  );

  it.effect("leaves hidden folders out unless they are asked for", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const shown = yield* browseDirectory({ path: root, showHidden: true });
      expect(names(shown)).toEqual([".hidden", "Alpha", "repo", "zebra"]);
    }),
  );

  it.effect("badges the folder that holds a .git", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const listing = yield* browseDirectory({ path: root });
      const badged = listing.entries.filter((entry) => entry.isGitRepo).map((entry) => entry.name);
      expect(badged).toEqual(["repo"]);
    }),
  );

  it.effect("answers the path it actually read, so a breadcrumb addresses it again", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const listing = yield* browseDirectory({ path: `${root}/repo/..//` });
      expect(listing.entries.length).toBe(3);
      expect(nodePath.isAbsolute(listing.path)).toBe(true);
      // Reached again by its own answer, it is the same directory.
      const again = yield* browseDirectory({ path: listing.path });
      expect(again.path).toBe(listing.path);
    }),
  );

  it.effect("names a parent, and stops naming one at the root of the disk", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const listing = yield* browseDirectory({ path: root });
      expect(listing.parent).toBe(nodePath.dirname(listing.path));
      const top = yield* browseDirectory({ path: nodePath.parse(listing.path).root });
      expect(top.parent).toBeNull();
    }),
  );

  it.effect("lists a symlinked folder but never badges it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const elsewhere = yield* Effect.sync(makeTree);
      yield* Effect.sync(() => {
        symlinkSync(nodePath.join(elsewhere, "repo"), nodePath.join(root, "link-to-repo"));
        symlinkSync(nodePath.join(elsewhere, "notes.txt"), nodePath.join(root, "link-to-file"));
      });
      const listing = yield* browseDirectory({ path: root });
      expect(names(listing)).toEqual(["Alpha", "link-to-repo", "repo", "zebra"]);
      const link = listing.entries.find((entry) => entry.name === "link-to-repo");
      // It is a repository on the other side of the link. Saying so would mean
      // reading a directory the caller never asked this server to open.
      expect(link?.isGitRepo).toBe(false);
    }),
  );

  it.effect("drops a broken link rather than failing the listing", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      yield* Effect.sync(() =>
        symlinkSync(nodePath.join(root, "gone"), nodePath.join(root, "dangling")),
      );
      const listing = yield* browseDirectory({ path: root });
      expect(names(listing)).toEqual(["Alpha", "repo", "zebra"]);
    }),
  );

  it.effect("caps the listing and says that it did", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(() => {
        const base = mkdtempSync(nodePath.join(tmpdir(), "poseidon-browse-many-"));
        for (let index = 0; index < 12; index += 1) {
          mkdirSync(nodePath.join(base, `folder-${String(index).padStart(2, "0")}`));
        }
        return base;
      });
      const listing = yield* browseDirectory({ path: root, limit: 5 });
      expect(names(listing)).toEqual([
        "folder-00",
        "folder-01",
        "folder-02",
        "folder-03",
        "folder-04",
      ]);
      expect(listing.truncated).toBe(true);
    }),
  );

  it.effect("refuses a relative path instead of resolving it somewhere invisible", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(browseDirectory({ path: "code/my-app" }));
      expect(failure.reason).toBe("not-absolute");
      expect(failure.path).toBe("code/my-app");
    }),
  );

  it.effect("tells a missing folder apart from a file", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(makeTree);
      const missing = yield* Effect.flip(browseDirectory({ path: nodePath.join(root, "nowhere") }));
      expect(missing.reason).toBe("not-found");
      const file = yield* Effect.flip(browseDirectory({ path: nodePath.join(root, "notes.txt") }));
      expect(file.reason).toBe("not-a-directory");
    }),
  );

  it.effect("reports an unreadable folder as permission-denied, with nothing of the cause", () =>
    Effect.gen(function* () {
      const locked = yield* Effect.sync(() => {
        const base = mkdtempSync(nodePath.join(tmpdir(), "poseidon-browse-locked-"));
        const inner = nodePath.join(base, "private");
        mkdirSync(inner);
        chmodSync(inner, 0o000);
        return inner;
      });
      const failure = yield* Effect.flip(browseDirectory({ path: locked }));
      yield* Effect.sync(() => chmodSync(locked, 0o700));
      expect(failure.reason).toBe("permission-denied");
      // The whole payload: nothing from errno, no server path the caller did
      // not already name, no cause object to walk.
      expect(Object.keys({ ...failure }).sort()).toEqual(["_tag", "path", "reason"]);
      expect(failure.message).toBe("That folder cannot be opened.");
    }),
  );

  it.effect("keeps listing a folder that holds one it cannot read", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(() => {
        const base = makeTree();
        const inner = nodePath.join(base, "locked");
        mkdirSync(inner);
        chmodSync(inner, 0o000);
        return base;
      });
      const listing = yield* browseDirectory({ path: root });
      yield* Effect.sync(() => chmodSync(nodePath.join(root, "locked"), 0o700));
      // Present, and unbadged: the `.git` lookup inside it fails and answers no.
      expect(names(listing)).toEqual(["Alpha", "locked", "repo", "zebra"]);
      expect(listing.entries.find((entry) => entry.name === "locked")?.isGitRepo).toBe(false);
    }),
  );

  it.effect("opens on the server user's home when no path is given", () =>
    Effect.gen(function* () {
      const listing = yield* browseDirectory();
      expect(nodePath.isAbsolute(listing.path)).toBe(true);
    }),
  );
});
