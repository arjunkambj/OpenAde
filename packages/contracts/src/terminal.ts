/**
 * The integrated terminal on the wire.
 *
 * A terminal is a shell the server runs in a pseudo-terminal for one thread,
 * with the thread's workspace as its working directory. The client mints the
 * `TerminalId`, so `terminal.open` is idempotent and a client that comes back
 * to a thread reattaches to the same shell by id.
 *
 * Output is text, not bytes: the server decodes the pty's output as UTF-8 and
 * every length and offset here counts UTF-16 chars, the unit both ends' strings
 * are measured in.
 */

import * as Schema from "effect/Schema";

import { IsoDateTime, NonEmptyString, NonNegativeInt } from "./base";
import { TerminalId, ThreadId } from "./ids";

// ── Limits both ends share ─────────────────────────────────────

/** Chars of recent output the server keeps per terminal, so a reattaching client sees it. */
export const TERMINAL_SCROLLBACK_CHARS = 1024 * 1024;

/** How long the server holds output back before sending it as one item, so a flood is not a frame per write. */
export const TERMINAL_BATCH_MS = 16;

/** The most chars one `output` item carries, so a flood cannot become one huge frame. */
export const TERMINAL_BATCH_CHARS = 64 * 1024;

/**
 * The budget on one `terminal.subscribe`, larger than the generic stream
 * budget because a busy shell produces many small items. A subscriber past it
 * is sent `resnapshot-required` instead of an ever-growing backlog.
 */
export const TERMINAL_STREAM_BUDGET_BYTES = 4 * 1024 * 1024;
export const TERMINAL_STREAM_BUDGET_ITEMS = 4096;

/** Open terminals one thread may hold, so a runaway client cannot fork shells without end. */
export const TERMINALS_PER_THREAD = 8;

/** The most chars one `terminal.write` may carry: a large paste fits, an unbounded frame does not. */
export const TERMINAL_WRITE_MAX_CHARS = 1024 * 1024;

// ── Shapes ─────────────────────────────────────────────────────

/** A terminal's grid, in character cells. The bounds keep a bad measure from reaching the pty. */
export const TerminalSize = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type TerminalSize = typeof TerminalSize.Type;

/**
 * One terminal as the server knows it. An `exited` terminal stays listed, with
 * its output, until the client closes it, so the last thing a command printed
 * is still readable after the shell has gone.
 */
export const TerminalSummary = Schema.Struct({
  terminalId: TerminalId,
  threadId: ThreadId,
  title: NonEmptyString,
  cwd: NonEmptyString,
  pid: NonNegativeInt,
  ...TerminalSize.fields,
  status: Schema.Literals(["running", "exited"]),
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: IsoDateTime,
});
export type TerminalSummary = typeof TerminalSummary.Type;

/**
 * One frame of a `terminal.subscribe` stream: a `snapshot` first, then
 * `output` as the shell writes it, `exited` when the shell ends, and
 * `resnapshot-required` when the subscriber fell behind its budget and has to
 * subscribe again.
 *
 * `offset` is the total number of chars the terminal has produced up to the
 * end of that item — for a snapshot, up to the end of the scrollback it
 * carries. The server subscribes to live output before it reads the
 * scrollback, so an `output` item can overlap the snapshot. A client drops any
 * `output` whose offset is at or below the offset it already holds, which is
 * what keeps the gap between subscribing and reading the snapshot from either
 * duplicating or losing output.
 */
export const TerminalStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    terminal: TerminalSummary,
    data: Schema.String,
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    data: Schema.String,
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("exited"),
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal("resnapshot-required"),
    reason: Schema.String,
  }),
]);
export type TerminalStreamItem = typeof TerminalStreamItem.Type;
