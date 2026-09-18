/**
 * The session reference: what it is, where its transcript lives, and whether
 * the harness can still resume it.
 *
 * Command Code's print mode runs one process per turn, so continuing a
 * conversation means handing the next process `--session <id>`. The engine
 * persists the reference between spawns — and across a server restart — which
 * makes "is this id still resumable?" a question the connector has to be able
 * to answer before it builds an argv, not after a run has already failed.
 */

import { findTranscriptPath, transcriptPathFor } from "./transcript";

/** The opaque `sessionRef` the engine persists between process spawns. */
export interface CmdSessionRef {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
  /**
   * Newest transcript message already emitted — `meta.messageId` or the line
   * id. On resume the tailer picks up right after it: lines written while the
   * server was down get emitted, earlier ones don't repeat.
   */
  readonly lastMessageId: string | null;
}

export interface SessionRefLocator {
  /**
   * The transcript path a reference should carry. `findTranscriptPath` answers
   * with the directory the harness really used; before the file exists there
   * is nothing to find, so the slug guess stands in until it does — the ref is
   * rewritten on every event that touches it, and the last write wins.
   */
  readonly pathOf: (sessionId: string) => string;
  /**
   * The reference to resume with, or `null` when the harness could not.
   *
   * `--session <id>` against an id with no transcript on disk is not a fresh
   * start, it is a failed run:
   *
   *     Error: --session "<id>" is neither an existing .jsonl transcript
   *     nor a known session-id prefix.
   *
   * and the process exits 1 before emitting a single frame. A run killed by
   * SIGINT never writes its transcript, so the id taken from its `run_start`
   * names a session that no longer exists anywhere — which left every turn
   * after the user pressed Stop failing, forever, on a thread that looked
   * perfectly healthy (`fixtures/cmd/interrupt-resume/`, turn 2).
   *
   * Asking the filesystem is the same question the harness asks, so the answer
   * cannot drift from it.
   */
  readonly resumable: (ref: CmdSessionRef | null) => CmdSessionRef | null;
}

/**
 * A locator bound to one session's workspace.
 *
 * `root` is the resolved workspace root the harness runs in — the transcript
 * directory is derived from it — and `home` overrides `~` for tests and for
 * anything that must not touch the operator's own `~/.commandcode`.
 */
export const makeSessionRefLocator = (options: {
  readonly root: string;
  readonly home?: string;
}): SessionRefLocator => {
  const pathOf = (sessionId: string): string =>
    findTranscriptPath(options.root, sessionId, options.home) ??
    transcriptPathFor(options.root, sessionId, options.home);
  return {
    pathOf,
    resumable: (ref) =>
      ref === null || findTranscriptPath(options.root, ref.sessionId, options.home) !== null
        ? ref
        : null,
  };
};
