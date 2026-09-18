/**
 * Where a composer image lives between the paste and the prompt.
 *
 * `~/.openade/attachments/<threadId>/` — the very directory
 * `ConnectorServices.attachmentsDir` already names (spec section 8 step 1), so
 * a file staged here is already where a connector expects to find it and no
 * second copy is made.
 *
 * The bytes cross the wire exactly twice: once up, in `attachments.stage`, and
 * once back down per thumbnail, in `attachments.read`. They never enter the
 * event log — `thread.turn.start` carries the reference this returns, which is
 * what keeps a replayed log from re-sending every screenshot ever pasted.
 *
 * Nothing here trusts a name. The media type is sniffed from the file's own
 * header both on the way in and on the way out, the stored extension comes
 * from that sniff, and every path is resolved and checked against the thread's
 * own directory before it is touched.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";
import type { ThreadId } from "@OpenAde/contracts/ids";
import type { AttachmentBytes, StagedAttachment } from "@OpenAde/contracts/rpc";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import {
  IMAGE_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  safeAttachmentName,
  sniffImageMediaType,
} from "@OpenAde/shared/imageBytes";
import { configPath } from "@OpenAde/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const invalid = (message: string) => new OpenAdeRpcError({ code: "invalid", message });

/** Base64 expands by 4/3; refusing on the text length avoids decoding a bomb. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4;

/** Owner-only: an attachment is the user's, and never executable. */
const FILE_MODE = 0o600;

/**
 * The same for the directories. The files were already 0600, but `mkdir`
 * left `~/.openade/attachments` and every thread's folder at 0755 under the
 * usual umask, so their names — and the names are the user's own file names —
 * were listable by any other local account. `chmod` as well as the `mkdir`
 * mode: a directory that already exists keeps the mode it was made with.
 */
const DIRECTORY_MODE = 0o700;

/**
 * `child` resolved under `parent`, or `null` when it escapes. Compared on the
 * normalised strings with a separator appended, so `/a/bc` never passes for
 * being inside `/a/b`.
 */
const containedPath = (parent: string, child: string): string | null => {
  const root = NodePath.resolve(parent);
  const resolved = NodePath.resolve(root, child);
  return resolved === root || resolved.startsWith(root + NodePath.sep) ? resolved : null;
};

export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    /** The directory a thread's attachments live in (created on demand). */
    readonly directoryFor: (threadId: ThreadId) => string;
    readonly stage: (input: {
      readonly threadId: ThreadId;
      readonly name: string;
      readonly base64: string;
    }) => Effect.Effect<StagedAttachment, OpenAdeRpcError>;
    readonly read: (
      threadId: ThreadId,
      path: string,
    ) => Effect.Effect<AttachmentBytes, OpenAdeRpcError>;
    /** Removes everything a thread staged. Never fails: cleanup is best effort. */
    readonly purge: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("server/attachments/AttachmentStore") {
  static readonly layer = Layer.sync(AttachmentStore, () => make(configPath(["attachments"])));

  /** For tests: the same store rooted somewhere disposable. */
  static readonly layerAt = (root: string) => Layer.sync(AttachmentStore, () => make(root));
}

const make = (root: string) => {
  const directoryFor = (threadId: ThreadId): string => NodePath.join(root, threadId);

  const stage = (input: {
    readonly threadId: ThreadId;
    readonly name: string;
    readonly base64: string;
  }) =>
    Effect.gen(function* () {
      if (input.base64.length > MAX_BASE64_LENGTH) {
        return yield* Effect.fail(invalid("the attachment is too large"));
      }
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length === 0) {
        return yield* Effect.fail(invalid("the attachment is empty"));
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return yield* Effect.fail(invalid("the attachment is too large"));
      }
      // The name says nothing. Only the header does.
      const mediaType = sniffImageMediaType(bytes);
      if (mediaType === null) {
        return yield* Effect.fail(invalid("only PNG, JPEG, GIF and WebP images can be attached"));
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const base = safeAttachmentName(input.name);
      const extension = IMAGE_EXTENSIONS[mediaType];
      // The stored name is ours end to end: a content prefix so two pastes of
      // the same picture share a file, the sanitised name so a prompt line
      // still reads like the user's, and the extension the sniff chose.
      const stem = base.endsWith(`.${extension}`) ? base.slice(0, -(extension.length + 1)) : base;
      const fileName = `${sha256.slice(0, 12)}-${stem}.${extension}`;

      const directory = directoryFor(input.threadId);
      const target = containedPath(directory, fileName);
      if (target === null) {
        return yield* Effect.fail(invalid("the attachment name is not usable"));
      }

      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
          for (const path of [root, directory]) {
            await chmod(path, DIRECTORY_MODE).catch(() => undefined);
          }
          await writeFile(target, bytes, { mode: FILE_MODE });
        },
        catch: () => new OpenAdeRpcError({ code: "internal", message: "internal error" }),
      });

      return {
        path: target,
        name: base,
        mime: mediaType,
        size: bytes.length,
        sha256,
      } satisfies StagedAttachment;
    });

  const read = (threadId: ThreadId, path: string) =>
    Effect.gen(function* () {
      const directory = directoryFor(threadId);
      if (containedPath(directory, path) === null) {
        return yield* Effect.fail(
          new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
        );
      }
      // Resolve links before believing the containment check: a symlink inside
      // the directory would otherwise read anything the server user can.
      const real = yield* Effect.tryPromise({
        try: () => realpath(NodePath.resolve(directory, path)),
        catch: () => new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
      });
      const realDirectory = yield* Effect.tryPromise({
        try: () => realpath(directory),
        catch: () => new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
      });
      if (containedPath(realDirectory, real) === null) {
        return yield* Effect.fail(
          new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
        );
      }

      const size = yield* Effect.tryPromise({
        try: () => stat(real),
        catch: () => new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
      }).pipe(Effect.map((stats) => stats.size));
      if (size > MAX_ATTACHMENT_BYTES) {
        return yield* Effect.fail(invalid("the attachment is too large"));
      }

      const bytes = yield* Effect.tryPromise({
        try: () => readFile(real),
        catch: () => new OpenAdeRpcError({ code: "not-found", message: "no such attachment" }),
      });
      // Sniffed again: whatever wrote the file, what leaves here is an image
      // or nothing, so a `data:` URL can never declare a type it is not.
      const mediaType = sniffImageMediaType(bytes);
      if (mediaType === null) {
        return yield* Effect.fail(invalid("the attachment is not a readable image"));
      }
      return {
        mime: mediaType,
        size: bytes.length,
        base64: bytes.toString("base64"),
      } satisfies AttachmentBytes;
    });

  const purge = (threadId: ThreadId) =>
    Effect.promise(() => rm(directoryFor(threadId), { recursive: true, force: true })).pipe(
      Effect.ignore,
    );

  return AttachmentStore.of({ directoryFor, stage, read, purge });
};
