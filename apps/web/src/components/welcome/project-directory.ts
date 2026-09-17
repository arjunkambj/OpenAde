/**
 * The welcome flow's "Project directory" field, as a value.
 *
 * The bug this exists to prevent: the field used to be a `CommitInput`, which
 * only publishes what was typed on blur. "Create project" is disabled while the
 * published value is empty, and a disabled button takes no pointer events — so
 * on a fresh install, where `/welcome` is the only way in, typing a path left
 * the button disabled and clicking it could not blur the field to enable it.
 * The path is now the truth from the first keystroke, and these functions are
 * the contract that keeps it that way.
 *
 * Three paths reach the same state: a typed path, the desktop picker's answer,
 * and a path the server refused. A rejection keeps the text so it can be
 * corrected, and never bars another attempt — "could not reach the server" is a
 * rejection too, and retrying it is exactly the right move.
 */

import { workspacePathProblem } from "@/lib/workspace-path";

export interface DirectoryState {
  /** Exactly what the field shows, untrimmed. */
  readonly path: string;
  /** The server's reason for refusing this path, until the path changes. */
  readonly rejection: string | null;
}

export const emptyDirectory: DirectoryState = { path: "", rejection: null };

/** A keystroke. The new text is the truth immediately — nothing waits for blur. */
export const directoryTyped = (path: string): DirectoryState => ({ path, rejection: null });

/** The native picker answered. Same state, and the same next step. */
export const directoryPicked = (path: string): DirectoryState => directoryTyped(path);

/** `project.create` came back rejected; keep the text so it can be edited. */
export const directoryRejected = (state: DirectoryState, reason: string): DirectoryState => ({
  ...state,
  rejection: reason,
});

/**
 * What to show under the field: a problem visible in the string itself first
 * (it is the one the user can act on), the server's reason otherwise.
 */
export const directoryProblem = (state: DirectoryState): string | null =>
  workspacePathProblem(state.path) ?? state.rejection;

/** Whether "Create project" is live. A rejection never latches it off. */
export const canCreateProject = (state: DirectoryState, creating: boolean): boolean =>
  !creating && state.path.trim() !== "" && workspacePathProblem(state.path) === null;
