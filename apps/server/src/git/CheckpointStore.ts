/**
 * Per-turn worktree snapshots as hidden git refs:
 * `refs/openade/checkpoints/<threadId>/<turnId>` points at a commit built from
 * a temporary index, so capture never disturbs the user's real index or
 * staging area. Restore is the reverse: `git restore` from the checkpoint
 * commit plus `git clean -fd` for paths the checkpoint never tracked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeCheckpointId } from "@OpenAde/contracts/ids";
import type { CheckpointSummary } from "@OpenAde/contracts/orchestration";
import type { ThreadId, TurnId } from "@OpenAde/contracts/ids";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { run } from "./process";

export class CheckpointStoreError extends Data.TaggedError("CheckpointStoreError")<{
  readonly message: string;
}> {}

const REF_PREFIX = "refs/openade/checkpoints";
const refFor = (threadId: ThreadId, turnId: TurnId) => `${REF_PREFIX}/${threadId}/${turnId}`;

const gitEnv = {
  GIT_AUTHOR_NAME: "OpenAde",
  GIT_AUTHOR_EMAIL: "openade@localhost",
  GIT_COMMITTER_NAME: "OpenAde",
  GIT_COMMITTER_EMAIL: "openade@localhost",
} satisfies NodeJS.ProcessEnv;

const wrap = <A>(
  effect: Effect.Effect<A, import("./process").GitError | CheckpointStoreError>,
): Effect.Effect<A, CheckpointStoreError> =>
  effect.pipe(
    Effect.mapError((error) =>
      error._tag === "CheckpointStoreError"
        ? error
        : new CheckpointStoreError({ message: error.message }),
    ),
  );

const hasHead = (cwd: string) =>
  run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowNonZeroExit: true,
  }).pipe(Effect.map((result) => result.exitCode === 0));

const resolveCommit = (cwd: string, ref: string) =>
  run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowNonZeroExit: true,
  }).pipe(
    Effect.map((result) => {
      const sha = result.stdout.trim();
      return result.exitCode === 0 && sha.length > 0 ? sha : null;
    }),
  );

export interface CheckpointStoreShape {
  readonly capture: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<CheckpointSummary, CheckpointStoreError>;
  readonly list: (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ReadonlyArray<CheckpointSummary>, CheckpointStoreError>;
  readonly restore: (input: {
    readonly workspaceRoot: string;
    readonly checkpoint: CheckpointSummary;
  }) => Effect.Effect<void, CheckpointStoreError>;
  readonly prune: (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void, CheckpointStoreError>;
}

export const make: CheckpointStoreShape = {
  /**
   * Snapshot the worktree into `refs/openade/checkpoints/<thread>/<turn>`:
   * read HEAD into a temp index, `add -A` every worktree path, write the tree,
   * commit it with a detached identity, and point the hidden ref at it.
   */
  capture: ({ threadId, turnId, workspaceRoot }) =>
    wrap(
      Effect.gen(function* () {
        const tempDir = mkdtempSync(nodePath.join(tmpdir(), "openade-checkpoint-"));
        const tempIndex = nodePath.join(tempDir, "index");
        const env = { ...gitEnv, GIT_INDEX_FILE: tempIndex };
        try {
          if (yield* hasHead(workspaceRoot)) {
            yield* run(workspaceRoot, ["read-tree", "HEAD"], { env });
          }
          yield* run(workspaceRoot, ["add", "-A", "--", "."], { env });
          const tree = yield* run(workspaceRoot, ["write-tree"], { env });
          const commit = yield* run(
            workspaceRoot,
            ["commit-tree", tree.stdout.trim(), "-m", `openade checkpoint ${turnId}`],
            { env },
          );
          const ref = refFor(threadId, turnId);
          yield* run(workspaceRoot, ["update-ref", ref, commit.stdout.trim()]);
          return {
            checkpointId: makeCheckpointId(),
            turnId,
            ref,
            createdAt: new Date().toISOString(),
          } satisfies CheckpointSummary;
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),

  /** `for-each-ref` on the thread's ref prefix, oldest first. */
  list: ({ threadId, workspaceRoot }) =>
    wrap(
      Effect.gen(function* () {
        const result = yield* run(workspaceRoot, [
          "for-each-ref",
          "--format=%(refname)%00%(creatordate:iso-strict)",
          `${REF_PREFIX}/${threadId}`,
        ]);
        const summaries: Array<CheckpointSummary> = [];
        for (const line of result.stdout.split("\n")) {
          if (line.length === 0) continue;
          const [ref, createdAt] = line.split("\0");
          const turnId = ref!.split("/").pop();
          if (turnId === undefined) continue;
          summaries.push({
            checkpointId: makeCheckpointId(),
            turnId: turnId as TurnId,
            ref: ref!,
            createdAt: createdAt ?? new Date(0).toISOString(),
          });
        }
        return summaries;
      }),
    ),

  /**
   * Revert worktree and index to the checkpoint commit, then clean untracked
   * files the checkpoint did not know about.
   */
  restore: ({ workspaceRoot, checkpoint }) =>
    wrap(
      Effect.gen(function* () {
        const commit = yield* resolveCommit(workspaceRoot, checkpoint.ref);
        if (commit === null) {
          return yield* new CheckpointStoreError({
            message: `checkpoint ref ${checkpoint.ref} does not resolve`,
          });
        }
        const tracked = yield* run(workspaceRoot, [
          "ls-files",
          "--cached",
          `--with-tree=${commit}`,
          "-z",
          "--",
          ".",
        ]);
        if (tracked.stdout.length > 0) {
          yield* run(workspaceRoot, [
            "restore",
            "--source",
            commit,
            "--worktree",
            "--staged",
            "--",
            ".",
          ]);
        }
        yield* run(workspaceRoot, ["clean", "-fd", "--", "."], {
          allowNonZeroExit: true,
        });
        // Keep the real index pointing at HEAD rather than the checkpoint.
        if (yield* hasHead(workspaceRoot)) {
          yield* run(workspaceRoot, ["read-tree", "HEAD"]);
        }
      }),
    ),

  /** Thread deleted → every checkpoint ref under its prefix goes. */
  prune: ({ threadId, workspaceRoot }) =>
    wrap(
      Effect.gen(function* () {
        const refs = yield* run(workspaceRoot, [
          "for-each-ref",
          "--format=%(refname)",
          `${REF_PREFIX}/${threadId}`,
        ]);
        for (const ref of refs.stdout.split("\n")) {
          if (ref.length === 0) continue;
          yield* run(workspaceRoot, ["update-ref", "-d", ref]);
        }
      }),
    ),
};
