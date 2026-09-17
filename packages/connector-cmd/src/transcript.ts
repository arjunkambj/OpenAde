/**
 * The on-disk session transcript (spec 5.3).
 *
 * Command Code writes `~/.commandcode/projects/<slug>/<sessionId>.jsonl`,
 * where `slug` is the session's cwd lowercased with `/` → `-` and the leading
 * dash stripped (`/Volumes/x` → `volumes-x`). The connector tails that file by
 * byte offset and parses complete `\n`-terminated lines only — a partial write
 * is held until its newline lands.
 *
 * The file may not exist when the tailer starts (the harness creates it at
 * `run_start`, and a resumed session's file may be gone entirely), so the
 * reader polls rather than watches: fs.watch on a not-yet-existing path is
 * exactly the case the platforms disagree on. Fifty milliseconds of polling is
 * cheap next to a turn and keeps the fake-process tests fast.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** How often the tailer re-reads the file for appended bytes. */
export const TAIL_POLL_MS = 50;

/** The transcript directory name under the harness's config dir. */
const slugFor = (cwd: string): string => {
  const slug = cwd.toLowerCase().replaceAll("/", "-");
  return slug.startsWith("-") ? slug.slice(1) : slug;
};

/**
 * `~/.commandcode/projects/<slug>` for a session running in `cwd`. `home`
 * overrides the home directory — tests point it at a temp dir; sessions leave
 * it out so `HOME` (and the harness's own resolution) stays authoritative.
 */
export const transcriptDirFor = (cwd: string, home?: string): string =>
  NodePath.join(home ?? NodeOS.homedir(), ".commandcode", "projects", slugFor(cwd));

export const transcriptPathFor = (cwd: string, sessionId: string, home?: string): string =>
  NodePath.join(transcriptDirFor(cwd, home), `${sessionId}.jsonl`);

export interface TranscriptTail {
  /** Complete `\n`-terminated lines, in file order, from the start offset on. */
  readonly lines: Stream.Stream<string>;
  /** Stops the reader and ends the stream. Idempotent. */
  readonly stop: Effect.Effect<void>;
}

export interface TailOptions {
  /**
   * Where to begin. `false` (default) starts at the file's current end — spec
   * section 8 tails new appends only, so a resumed session does not replay its
   * whole history into the timeline. `true` reads the file from byte zero,
   * which is what a test against a pre-seeded fixture wants.
   */
  readonly fromStart?: boolean;
  readonly pollMs?: number;
}

interface ReadResult {
  readonly data: string;
  readonly size: number;
}

/** The bytes after `offset`, or null when the file does not exist (yet). */
const readFrom = (path: string, offset: number): ReadResult | null => {
  let fd: number;
  try {
    fd = NodeFS.openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = NodeFS.fstatSync(fd);
    if (size < offset) {
      // Truncated or replaced — a fresh session file under the same name.
      return { data: "", size: 0 };
    }
    if (size === offset) {
      return { data: "", size };
    }
    const buffer = Buffer.alloc(size - offset);
    const read = NodeFS.readSync(fd, buffer, 0, size - offset, offset);
    return { data: buffer.toString("utf8", 0, read), size };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * Tails `path` by byte offset. Bound to the surrounding scope: closing the
 * scope, or calling `stop`, ends the reader and the stream together.
 */
export const tailTranscript = (
  path: string,
  options: TailOptions = {},
): Effect.Effect<TranscriptTail, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<string, Cause.Done>({ capacity: 8192 });
    const stopped = yield* Deferred.make<void>();

    const pollMs = options.pollMs ?? TAIL_POLL_MS;

    // "Current byte offset" is decided once, at start: an existing file is
    // skipped to end (unless `fromStart`), a not-yet-created file starts at
    // byte zero when it appears — nothing was written before we began.
    let offset =
      options.fromStart === true
        ? 0
        : yield* Effect.sync(() => {
            const initial = readFrom(path, 0);
            return initial === null ? 0 : initial.size;
          });

    const loop = Effect.gen(function* () {
      let pending = "";
      while (true) {
        const result = yield* Effect.sync(() => readFrom(path, offset));
        if (result !== null) {
          if (result.size < offset) {
            // Truncated or replaced — a fresh session file under the same name.
            offset = 0;
            pending = "";
          } else {
            offset = result.size;
            pending += result.data;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (line.length > 0) {
                yield* Queue.offer(queue, line);
              }
            }
          }
        }
        yield* Effect.sleep(pollMs);
      }
    });

    const fiber = yield* Effect.forkScoped(Effect.raceFirst(loop, Deferred.await(stopped)));

    const stop = Deferred.succeed(stopped, undefined).pipe(
      Effect.andThen(Queue.end(queue)),
      Effect.asVoid,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* stop;
        yield* Fiber.await(fiber);
      }),
    );

    return { lines: Stream.fromQueue(queue), stop };
  });
