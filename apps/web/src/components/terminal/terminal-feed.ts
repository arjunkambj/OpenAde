/**
 * Writes one terminal's attach stream into an xterm, and says when the xterm's
 * `onData` is the user's to send.
 *
 * A `snapshot` resets the xterm to the terminal's scrollback — the first one on
 * attach, and a fresh one after `resnapshot-required` or a dropped socket.
 * xterm parses writes from a queue, and `reset()` leaves that queue alone, so
 * output of the earlier subscription can still be waiting there: reset at once
 * and it is parsed into the freshly reset screen, ahead of the snapshot that
 * already holds it. The reset therefore waits until every earlier write has
 * been parsed, and items arriving meanwhile are held and written after the
 * snapshot, in order.
 *
 * Input is held back while that queue drains and while a snapshot is parsed:
 * both carry the shell's old terminal queries — cursor position, device
 * attributes, background colour — and xterm answers each one through `onData`,
 * as if typed; those answers belong to a prompt long gone. A query in live
 * output is answered as usual, since a program is waiting for it.
 */

import type { TerminalAttachItem } from "@OpenAde/client-runtime/terminalAtoms";
import type { TerminalSize } from "@OpenAde/contracts/terminal";

/** The part of an xterm the feed writes to. */
export interface FeedTerminal {
  readonly reset: () => void;
  readonly write: (data: string, callback?: () => void) => void;
}

export interface TerminalFeedHandlers {
  /** A snapshot was written; `size` is the grid the server's pty has. */
  readonly onSnapshot: (size: TerminalSize) => void;
  readonly onExited: (exitCode: number | null) => void;
  readonly onGone: () => void;
}

export interface TerminalFeed {
  readonly push: (item: TerminalAttachItem) => void;
  /** Whether what xterm hands `onData` now is the user's, to send to the shell. */
  readonly acceptsInput: () => boolean;
  /** Write nothing more; items still held are dropped. */
  readonly stop: () => void;
}

export const exitLine = (exitCode: number | null, signal: number | null): string =>
  exitCode !== null
    ? `[process exited with code ${exitCode}]`
    : signal !== null
      ? `[process ended by signal ${signal}]`
      : "[process exited]";

export const makeTerminalFeed = (
  terminal: FeedTerminal,
  handlers: TerminalFeedHandlers,
): TerminalFeed => {
  let live = true;
  // Output is kept only past this offset; the snapshot sets it.
  let offset = -1;
  // Snapshots written but not yet parsed.
  let replaying = 0;
  // Items that arrived while a snapshot waits for earlier writes to be parsed;
  // null when no snapshot is waiting.
  let held: Array<TerminalAttachItem> | null = null;

  const apply = (item: TerminalAttachItem): void => {
    if (held !== null) {
      held.push(item);
      return;
    }
    switch (item.kind) {
      case "snapshot":
        held = [];
        // Called once everything written before it has been parsed.
        terminal.write("", () => {
          if (!live) {
            return;
          }
          const later = held ?? [];
          held = null;
          terminal.reset();
          replaying += 1;
          terminal.write(item.data, () => {
            replaying -= 1;
          });
          offset = item.offset;
          handlers.onSnapshot({ cols: item.terminal.cols, rows: item.terminal.rows });
          // A later snapshot among these waits again and holds the rest.
          later.forEach(apply);
        });
        return;
      case "output":
        if (item.offset > offset) {
          terminal.write(item.data);
          offset = item.offset;
        }
        return;
      case "exited":
        terminal.write(`\r\n${exitLine(item.exitCode, item.signal)}\r\n`);
        handlers.onExited(item.exitCode);
        return;
      case "resnapshot-required":
        // The attach loop subscribes again; its snapshot resets the view.
        return;
      case "gone":
        handlers.onGone();
        return;
    }
  };

  return {
    push: (item) => {
      if (live) {
        apply(item);
      }
    },
    acceptsInput: () => held === null && replaying === 0,
    stop: () => {
      live = false;
      held = null;
    },
  };
};
