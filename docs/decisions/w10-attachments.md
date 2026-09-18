# W10 — image attachments, end to end

Date: 2026-09-18. Closes audit gaps **W5.6** ("attachments are filenames only")
and **W2.7** ("images declared unsupported, nothing ever written to
`attachmentsDir`"). Spec §01 lists image attachments as MVP scope, §11 asks the
composer for "image paste or drop", §8 step 1 tells the connector to "write
attachments to `<attachmentsDir>/<threadId>/`".

## 1. Research: how does print mode take an image?

`npx -y command-code@1.54.0 --help` was run on this machine (help only — the
account still has no credits, so no prompt was ever sent). The full option list
has **no image, attach or file flag**:

```
-p, --print [query]        Run in non-interactive mode, output response and exit
--output-format <format>   -p output: text (default) or json (NDJSON + result line)
--add-dir <directory>      Add directory to workspace context
--tools-all / --tools-enable <names>
--session <path|id> · --model · --effort · --permission-mode · --yolo · ...
```

stdin is not an input channel either: `spawnProcess` already wires
`stdio: ["ignore", "pipe", "pipe"]` and the CLI's headless mode takes its query
from `-p`.

That matches the open question the spec itself records (§5.7, line 390):

> How are images attached in print mode? No flag is documented. Fallback: write
> the image to the attachments dir and reference the path in the prompt.

The transcript's own message format does carry image blocks
(`{type:"image",source:{type:"base64",media_type,data}}`, §5.2/5.3) — but that
is what the harness writes _after_ it has read a file, not an input we can
hand it. Nothing on the argv surface accepts base64.

**Design chosen: the documented fallback.** A turn with attachments gets

1. the files on disk under `<attachmentsDir>/<threadId>/`,
2. `--add-dir <attachmentsDir>/<threadId>` so the harness is allowed to read
   them — without it the files sit outside the workspace root the session was
   started in, and the read tool would refuse,
3. one `Attachment (image/png): /absolute/path` line per file appended to the
   prompt, so the model knows the path is an image and worth reading.

Everything goes through `spawn` with an argv array — no shell, so a file name
is never interpolated into a command line.

Re-verify this when credits exist: if a later CLI grows a real image flag,
`buildArgs` is the only place that has to change.

## 2. Where the bytes live, and what travels on the wire

The event log is replayed on every boot and streamed to every client, so image
bytes must never enter it. They do not:

- The renderer reads the `File`, validates it, and base64-encodes it **once**
  into the new `attachments.stage` RPC.
- The server writes the file to
  `~/.openade/attachments/<threadId>/<sha-prefix>-<name>.<ext>` and answers with
  a reference only: `{ path, name, mime, size, sha256 }`.
- `thread.turn.start` (and therefore `thread.turn.requested`,
  `thread.message.queued` and the queue drain) carries that reference. The
  `Attachment` schema gained `name`, `size` and `sha256` — all optional, so
  every existing fixture still round-trips and a `{ path, mime }` attachment
  from an older client is still valid.
- The timeline asks for the bytes back with `attachments.read`, which answers a
  base64 payload the row turns into a `data:` URL. It travels over the same
  authenticated WebSocket as every other RPC, so no new public route exists and
  no token had to be minted.

`~/.openade/attachments` is exactly the directory `ConnectorServices.attachmentsDir`
already pointed at (`ConnectorHost.ts`), so a file the server staged is already
where §8 step 1 wants it and the connector does not copy it a second time. A
path from somewhere else — a future drag of a real file, a connector-side
caller — is copied in, which is the case W2.7 described.

## 3. Security

Four rules, all enforced server-side (the renderer's copy of the checks is a
courtesy so the user hears "too large" before uploading megabytes, never the
authority):

1. **Media type is sniffed, not trusted.** `sniffImageMediaType` in
   `@OpenAde/shared/imageBytes` reads magic bytes — PNG's 8-byte signature,
   JPEG's `FF D8 FF`, `GIF87a`/`GIF89a`, and `RIFF....WEBP`. A `.png` that is
   really a shell script is rejected, and the _stored_ extension comes from the
   sniff, never from the uploaded name. `attachments.read` sniffs again on the
   way out, so the media type a `data:` URL declares is the file's own.
2. **Paths are contained.** A staged file is named
   `<sha256 prefix>-<sanitised basename>.<ext>`, where the basename is
   stripped to `[A-Za-z0-9._-]` and capped, so `..` cannot survive it. Both
   `stage` and `read` then resolve the
   final path and refuse anything that is not under
   `<attachments>/<threadId>/`, and `read` resolves symlinks before the check.
   `threadId` is a `ThreadId` (UUIDv7) the schema decoded, so it cannot be a
   path fragment.
3. **Size is capped** at `MAX_ATTACHMENT_BYTES` (8 MiB) — checked on the
   base64 length _before_ decoding, on the decoded byte length, and again on
   `read`.
4. **Nothing is executed.** Files are written with `0o600`, never marked
   executable, and the only place a name reaches a child process is as one
   element of an argv array.

## 4. Cleanup

`AttachmentReactor` watches the engine's event stream and removes
`<attachments>/<threadId>/` on `thread.deleted`. It subscribes in the building
fiber and forks only the consume loop, for the reason the browser teardown
reactor records: a forked fiber does not start until the builder yields, and the
PubSub drops what it publishes with no subscriber.

Archived threads keep their attachments — an archived thread can be reopened and
its timeline still renders.

## 5. Proving it — and it is proved

This design was a documented fallback when it was written. It is now a
recording. `packages/testkit/fixtures/cmd/image/` is a real turn of
command-code 1.55.1 staged exactly this way: a PNG under an attachments
directory outside the workspace root, that directory passed as `--add-dir`, and
one `Attachment (image/png): <absolute path>` line in the prompt.

The model called `read_file` on the path. The harness answered with
`Read image red.png and attached it below for viewing (618 B, image/jpeg)` plus
a `{type:"image",source:{type:"base64",media_type,data}}` block — it transcodes
to JPEG on the way in — and the model replied with the colour of the pixels.

`apps/server/src/attachments/attachmentTurn.test.ts` runs the whole path against
that recording: composer validation → `attachments.stage` → bytes on disk →
`send()` → the argv and prompt the connector really builds, which the replay
records and the test asserts → the answer the real CLI gave when it was handed
the same thing.

## Things every later workstream must know

- Image bytes never go in the event log. `Attachment` is a _reference_
  (`path`, `mime`, `name`, `size`, `sha256`); the bytes live under
  `~/.openade/attachments/<threadId>/` and come back through
  `attachments.read`.
- `@OpenAde/shared/imageBytes` is the one place that decides whether some bytes
  are an image and which media type they are. Sniff there; never trust a name
  or a browser-declared `File.type`.
- A connector receives attachments whose `path` is already inside its
  `attachmentsDir`. Copy only what is not, and pass `--add-dir` (or the
  equivalent) so the harness may read the directory at all.
- `thread.turn.requested` now also emits `thread.item.upserted` with the
  `user_message` row. Nothing minted that row before, so the user's own message
  never appeared in the timeline; connectors must still not emit it (the
  translator's user-text branch stays a no-op) or every prompt would show twice.
