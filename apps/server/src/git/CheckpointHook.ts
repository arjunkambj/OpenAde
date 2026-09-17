/**
 * The W8 implementation of the orchestration `CheckpointHook` seam: capture
 * writes the hidden git ref and reports the summary the `thread.checkpoint.created`
 * event embeds; restore reverts the worktree to that ref.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointHook, CheckpointHookError } from "../orchestration/CheckpointReactor";
import { make as makeStore } from "./CheckpointStore";

const toHookError = (error: { readonly message: string }) =>
  new CheckpointHookError({ message: error.message });

export const layer = Layer.succeed(
  CheckpointHook,
  CheckpointHook.of({
    capture: ({ thread, turnId, workspaceRoot }) =>
      makeStore.capture({ threadId: thread.threadId, turnId, workspaceRoot }).pipe(
        // A non-repo workspace simply has nothing to snapshot — the store
        // says so in a field, so this never depends on git's wording.
        Effect.catch((error) =>
          error.notARepository ? Effect.succeed(null) : Effect.fail(toHookError(error)),
        ),
      ),
    restore: ({ checkpoint, workspaceRoot }) =>
      makeStore.restore({ checkpoint, workspaceRoot }).pipe(Effect.mapError(toHookError)),
    prune: ({ threadId, workspaceRoot }) =>
      makeStore.prune({ threadId, workspaceRoot }).pipe(Effect.mapError(toHookError)),
  }),
);
