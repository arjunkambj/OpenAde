/**
 * Staging, serving and purging a composer image — and the four ways a hostile
 * upload is turned away: a lying name, a traversing name, a symlink out of the
 * directory, and something that is simply too big.
 */

import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ThreadId } from "@poseidon/contracts/ids";
import { MAX_ATTACHMENT_BYTES } from "@poseidon/shared/imageBytes";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AttachmentStore } from "./AttachmentStore";

const THREAD = "0199c0de-0002-7000-8000-000000000001" as ThreadId;
const OTHER_THREAD = "0199c0de-0002-7000-8000-000000000002" as ThreadId;

/** A real 1x1 PNG — small, and its header is the one the sniff looks for. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GIF_BASE64 = Buffer.from(
  Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]),
).toString("base64");

const fixture = Effect.gen(function* () {
  const root = yield* Effect.sync(() =>
    mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-attachments-")),
  );
  const context = yield* Layer.build(AttachmentStore.layerAt(root));
  return { root, store: Context.get(context, AttachmentStore) };
});

describe("AttachmentStore.stage", () => {
  it.effect("writes the bytes under the thread and answers with a reference only", () =>
    Effect.gen(function* () {
      const { root, store } = yield* fixture;
      const staged = yield* store.stage({
        threadId: THREAD,
        name: "Screen Shot 2026-09-18.png",
        base64: PNG_BASE64,
      });

      expect(staged.mime).toBe("image/png");
      expect(staged.size).toBe(70);
      expect(staged.name).toBe("Screen-Shot-2026-09-18.png");
      expect(staged.path.startsWith(NodePath.join(root, THREAD) + NodePath.sep)).toBe(true);
      expect(NodePath.basename(staged.path)).toBe(
        `${staged.sha256.slice(0, 12)}-Screen-Shot-2026-09-18.png`,
      );
      expect(Object.keys(staged)).not.toContain("base64");

      const onDisk = yield* Effect.promise(() => readFile(staged.path));
      expect(onDisk.toString("base64")).toBe(PNG_BASE64);
    }),
  );

  it.effect("stores the file owner-only and never executable", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const staged = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      const stats = yield* Effect.promise(() => stat(staged.path));
      expect(stats.mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("keeps the directories owner-only too, including ones already there", () =>
    Effect.gen(function* () {
      // The file was already 0600, but the folders were 0755, so the names —
      // which are the user's own file names — were listable by anyone with an
      // account on the machine. The chmod is what fixes an install an earlier
      // build already created: `mkdir` does not lower an existing directory.
      const { root, store } = yield* fixture;
      yield* Effect.sync(() => {
        mkdirSync(NodePath.join(root, THREAD), { recursive: true });
        chmodSync(root, 0o755);
        chmodSync(NodePath.join(root, THREAD), 0o755);
      });
      const staged = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      for (const directory of [root, NodePath.dirname(staged.path)]) {
        const stats = yield* Effect.promise(() => stat(directory));
        expect(stats.mode & 0o777).toBe(0o700);
      }
    }),
  );

  it.effect("names the file from the sniff, not from the extension it was given", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const staged = yield* store.stage({
        threadId: THREAD,
        name: "actually-a-gif.png",
        base64: GIF_BASE64,
      });
      expect(staged.mime).toBe("image/gif");
      expect(staged.path.endsWith(".gif")).toBe(true);
    }),
  );

  it.effect("stages the same picture twice to one file", () =>
    Effect.gen(function* () {
      const { root, store } = yield* fixture;
      const first = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      const second = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      expect(second.path).toBe(first.path);
      const entries = yield* Effect.promise(() => readdir(NodePath.join(root, THREAD)));
      expect(entries).toHaveLength(1);
    }),
  );

  it.effect("refuses bytes that are not one of the four image formats", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const exit = yield* Effect.exit(
        store.stage({
          threadId: THREAD,
          name: "screenshot.png",
          base64: Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8").toString("base64"),
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("refuses an empty upload and one over the cap", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const empty = yield* Effect.exit(
        store.stage({ threadId: THREAD, name: "a.png", base64: "" }),
      );
      expect(empty._tag).toBe("Failure");

      const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x41).toString("base64");
      const over = yield* Effect.exit(
        store.stage({ threadId: THREAD, name: "a.png", base64: huge }),
      );
      expect(over._tag).toBe("Failure");
    }),
  );

  it.effect("cannot be walked out of its thread directory by a name", () =>
    Effect.gen(function* () {
      const { root, store } = yield* fixture;
      const staged = yield* store.stage({
        threadId: THREAD,
        name: "../../../../etc/passwd.png",
        base64: PNG_BASE64,
      });
      expect(staged.path.startsWith(NodePath.join(root, THREAD) + NodePath.sep)).toBe(true);
      expect(staged.path).not.toContain("..");
    }),
  );
});

describe("AttachmentStore.read", () => {
  it.effect("gives the bytes back with the media type it sniffed", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const staged = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      const bytes = yield* store.read(THREAD, staged.path);
      expect(bytes.mime).toBe("image/png");
      expect(bytes.size).toBe(70);
      expect(bytes.base64).toBe(PNG_BASE64);
    }),
  );

  it.effect("refuses a path outside the thread's own directory", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const staged = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });

      const traversal = yield* Effect.exit(store.read(THREAD, "../../etc/hosts"));
      expect(traversal._tag).toBe("Failure");

      // The same file, asked for by a thread that does not own it.
      const neighbour = yield* Effect.exit(store.read(OTHER_THREAD, staged.path));
      expect(neighbour._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a symlink that points out of the directory", () =>
    Effect.gen(function* () {
      const { root, store } = yield* fixture;
      yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      const secret = NodePath.join(root, "secret.png");
      const link = NodePath.join(root, THREAD, "link.png");
      yield* Effect.sync(() => {
        writeFileSync(secret, Buffer.from(PNG_BASE64, "base64"));
        symlinkSync(secret, link);
      });

      const exit = yield* Effect.exit(store.read(THREAD, link));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a file that is no longer an image", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const staged = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      yield* Effect.sync(() => writeFileSync(staged.path, "#!/bin/sh\n"));
      const exit = yield* Effect.exit(store.read(THREAD, staged.path));
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("AttachmentStore.purge", () => {
  it.effect("removes the thread's directory and leaves its neighbour alone", () =>
    Effect.gen(function* () {
      const { root, store } = yield* fixture;
      const mine = yield* store.stage({ threadId: THREAD, name: "a.png", base64: PNG_BASE64 });
      const theirs = yield* store.stage({
        threadId: OTHER_THREAD,
        name: "a.png",
        base64: PNG_BASE64,
      });

      yield* store.purge(THREAD);

      const gone = yield* Effect.exit(store.read(THREAD, mine.path));
      expect(gone._tag).toBe("Failure");
      const kept = yield* store.read(OTHER_THREAD, theirs.path);
      expect(kept.size).toBe(70);
      const entries = yield* Effect.promise(() => readdir(root));
      expect(entries).toEqual([OTHER_THREAD]);
    }),
  );

  it.effect("is a no-op for a thread that never attached anything", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      yield* store.purge(THREAD);
    }),
  );
});
