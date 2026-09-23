/**
 * The real `GitService` behind the `git.status`/`git.diff`/`checkpoints.list`
 * and branch RPCs: argv-form git over `process.ts`, porcelain-v2 parsing for
 * status, and unified patches split per file for the changes pane. Branch
 * listing, creation and switching live in `Branches.ts`; this layer resolves
 * the root and adds the one guard that needs the read models — no switch
 * while a turn runs in the same root. Each call runs in the thread's own root
 * when it names a thread (see `orchestration/workspaceRoot.ts`). A missing
 * `projectId` or a non-repository root answers `isRepository: false` with
 * empty results rather than an RPC error, so the pane can say "not a git
 * repository" instead of showing what looks like a clean tree.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { GitDiff, GitDiffFile, GitFileChange, GitStatus } from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";

import { resolveWorkspaceRoot, workspaceRootBusy } from "../orchestration/workspaceRoot";
import { ReadModelStore } from "../persistence/ReadModels";
import { GitService, type WorkspaceScope } from "../rpc/services";
import {
  checkoutBranch,
  createBranch,
  listBranches,
  mergeBaseOf,
  notRepositoryBranches,
  validRef,
} from "./Branches";
import { make as checkpointStore } from "./CheckpointStore";
import { GitError, isRepository, run } from "./process";

const toRpcError = (error: GitError) =>
  new OpenAdeRpcError({ code: "internal", message: error.message });

/** Passes a classified refusal through and turns an unexpected git failure into `internal`. */
const asRpcError = (error: GitError | OpenAdeRpcError) =>
  error instanceof OpenAdeRpcError ? error : toRpcError(error);

const NUL = "\0";

/** Porcelain v2 XY → the contract's status word. `?` rows are untracked. */
const statusOf = (xy: string): GitFileChange["status"] => {
  if (xy === "??") return "untracked";
  if (xy.includes("R") || xy.includes("C")) return "renamed";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
};

const parseStatus = (stdout: string): GitStatus => {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Array<GitFileChange> = [];
  const lines = stdout.split(NUL).filter((line) => line.length > 0);
  // Index-based: `2 ` rename rows consume the following NUL record too.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length) || null;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length) || null;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      ahead = match === null ? 0 : Number.parseInt(match[1]!, 10);
      behind = match === null ? 0 : Number.parseInt(match[2]!, 10);
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), status: "untracked", staged: false });
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // Fixed-field counts before the path: `1 ` carries 8 (`<XY> <sub>
      // <mH> <mI> <mW> <hH> <hI>`), `2 ` adds the `<X><score>` token (9),
      // `u ` carries 10. The path itself may contain spaces, so it is the
      // remainder of the row re-joined, never a single part.
      const pathStart = line.startsWith("2 ") ? 9 : line.startsWith("u ") ? 10 : 8;
      const path = parts.slice(pathStart).join(" ");
      let oldPath: string | undefined;
      if (line.startsWith("2 ")) {
        // A rename/copy row is followed by a second NUL record carrying the
        // original path — consume it so it is not mistaken for an entry.
        oldPath = lines[index + 1];
        if (oldPath !== undefined) {
          index += 1;
        }
      }
      files.push({
        path,
        ...(oldPath === undefined ? {} : { oldPath }),
        status: statusOf(xy),
        staged: xy[0] !== "." && xy[0] !== "?",
      });
    }
  }
  return { branch, upstream, ahead, behind, files };
};

const KIND_BY_PATCH_MARKER: ReadonlyArray<[RegExp, GitDiffFile["kind"]]> = [
  [/^new file mode/m, "create"],
  [/^deleted file mode/m, "delete"],
  [/^rename from /m, "edit"],
];

const kindOf = (patch: string): GitDiffFile["kind"] =>
  KIND_BY_PATCH_MARKER.find(([marker]) => marker.test(patch))?.[1] ?? "edit";

/** Split a unified patch into per-file entries on `diff --git` boundaries. */
const splitPatch = (patch: string): Array<{ path: string; oldPath?: string; chunk: string }> => {
  const chunks: Array<{ path: string; oldPath?: string; chunk: string }> = [];
  let current: { path: string; oldPath?: string; chunk: string } | undefined;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header !== null) {
      current = { path: header[2]!, oldPath: header[1], chunk: `${line}\n` };
      chunks.push(current);
      continue;
    }
    if (current !== undefined) {
      current.chunk += `${line}\n`;
    }
  }
  return chunks;
};

/**
 * `diff --numstat -z` records: `added\tdeleted\tpath` NUL for an ordinary
 * change, and `added\tdeleted\t` NUL `old` NUL `new` NUL for a rename or copy.
 * The NUL form is what makes the rename case usable — the plain output writes
 * it as the single field `old => new`, which matches no path the patch split
 * ever produces, so renamed files came back as +0/-0. Binary rows are `-\t-`.
 */
const parseNumstat = (stdout: string): Map<string, { added: number; deleted: number }> => {
  const map = new Map<string, { added: number; deleted: number }>();
  const records = stdout.split(NUL);
  for (let index = 0; index < records.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(records[index]!);
    if (match === null) continue;
    const counts = {
      added: match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10),
      deleted: match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10),
    };
    if (match[3]!.length > 0) {
      map.set(match[3]!, counts);
      continue;
    }
    // An empty path field means the next two records are `old` then `new`;
    // the patch split keys its entry on the new path.
    const newPath = records[index + 2];
    if (newPath !== undefined) map.set(newPath, counts);
    index += 2;
  }
  return map;
};

/**
 * Diff the worktree against `base` including untracked files: stage them with
 * `--intent-to-add` in a throwaway index so they appear as new-file diffs.
 * Ref→ref diffs skip this — every file is already tracked.
 */
const worktreeDiff = (cwd: string, base: string, path?: string) =>
  Effect.gen(function* () {
    const pathspec = path === undefined ? [] : ["--", path];
    const tempDir = mkdtempSync(nodePath.join(tmpdir(), "openade-index-"));
    const tempIndex = nodePath.join(tempDir, "index");
    const env = { GIT_INDEX_FILE: tempIndex };
    try {
      yield* run(cwd, ["read-tree", base], { env }).pipe(
        Effect.catch(() => Effect.void), // unborn HEAD: empty temp index is fine
      );
      // "Untracked" has to mean untracked *by the temporary index*, not by
      // the user's: a path the user has staged but not committed is absent
      // from the temp index too, so reading the real index here dropped every
      // staged-but-uncommitted file — and the new half of a staged rename —
      // out of the diff entirely.
      const untracked = yield* run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
        env,
      });
      const paths = untracked.stdout.split("\0").filter(Boolean);
      if (paths.length > 0) {
        yield* run(
          cwd,
          [
            "--literal-pathspecs",
            "add",
            "--intent-to-add",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { env, stdin: `${paths.join("\0")}\0` },
        );
      }
      const patch = yield* run(
        cwd,
        ["diff", "--patch", "--no-color", "--no-ext-diff", "--find-renames", base, ...pathspec],
        { env },
      );
      const numstat = yield* run(
        cwd,
        ["diff", "--numstat", "-z", "--find-renames", base, ...pathspec],
        { env },
      );
      return { patch: patch.stdout, numstat: numstat.stdout };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

const refDiff = (cwd: string, from: string, to: string | undefined, path?: string) =>
  Effect.gen(function* () {
    const range = to === undefined ? [from] : [from, to];
    const pathspec = path === undefined ? [] : ["--", path];
    const patch = yield* run(cwd, [
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      ...range,
      ...pathspec,
    ]);
    const numstat = yield* run(cwd, [
      "diff",
      "--numstat",
      "-z",
      "--find-renames",
      ...range,
      ...pathspec,
    ]);
    return { patch: patch.stdout, numstat: numstat.stdout };
  });

const toDiffFiles = (patch: string, numstat: string): Array<GitDiffFile> => {
  const counts = parseNumstat(numstat);
  return splitPatch(patch).map(({ path, oldPath, chunk }) => {
    const count = counts.get(path) ?? { added: 0, deleted: 0 };
    return {
      path,
      ...(oldPath !== undefined && oldPath !== path ? { oldPath } : {}),
      kind: kindOf(chunk),
      diff: chunk,
      additions: count.added,
      deletions: count.deleted,
    };
  });
};

const notRepo: GitDiff = { from: null, to: null, isRepository: false, files: [] };

export const layer = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;

    /** The thread's root when the scope names one, the project's otherwise. */
    const workspaceRoot = (scope: WorkspaceScope) =>
      resolveWorkspaceRoot(readModels, scope.projectId, scope.threadId).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              command: "project lookup",
              cwd: ".",
              exitCode: null,
              message: error.message,
            }),
        ),
      );

    /** A root a branch write can run in, or the reason it cannot. */
    const repositoryRoot = (scope: WorkspaceScope) =>
      Effect.gen(function* () {
        const root = yield* workspaceRoot(scope);
        if (root === null) {
          return yield* Effect.fail(
            new OpenAdeRpcError({ code: "not-found", message: "unknown project" }),
          );
        }
        if (!(yield* isRepository(root))) {
          return yield* Effect.fail(
            new OpenAdeRpcError({ code: "invalid", message: "not a git repository" }),
          );
        }
        return root;
      });

    /** No branch switch under a running turn or a checkpoint restore in the same root. */
    const requireIdle = (root: string) =>
      Effect.gen(function* () {
        const busy = yield* workspaceRootBusy(readModels, root).pipe(
          Effect.mapError(
            (error) => new OpenAdeRpcError({ code: "internal", message: error.message }),
          ),
        );
        if (busy) {
          return yield* Effect.fail(
            new OpenAdeRpcError({
              code: "conflict",
              message: "A turn is running in this workspace — stop it before switching branches.",
            }),
          );
        }
      });

    return GitService.of({
      status: (scope) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            // Named, not guessed: an empty `files` list with `isRepository`
            // false is what the pane renders as "not a git repository".
            return {
              branch: null,
              upstream: null,
              ahead: 0,
              behind: 0,
              isRepository: false,
              files: [],
            };
          }
          const result = yield* run(root, [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
          ]);
          return { ...parseStatus(result.stdout), isRepository: true };
        }).pipe(Effect.mapError(toRpcError)),

      diff: (scope, options) =>
        Effect.gen(function* () {
          if (options.mergeBase !== undefined && options.to !== undefined) {
            return yield* Effect.fail(
              new OpenAdeRpcError({
                code: "invalid",
                message: "a merge-base diff runs against the working tree and takes no `to`",
              }),
            );
          }
          const from = yield* validRef(options.from ?? "HEAD", "from");
          const to = options.to === undefined ? undefined : yield* validRef(options.to, "to");
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            return { ...notRepo, from: options.from ?? null, to: options.to ?? null };
          }
          // Branch against base: the fork point, not the base's tip, so the
          // base's own later commits never read as reverted here.
          const base =
            options.mergeBase === undefined ? from : yield* mergeBaseOf(root, options.mergeBase);
          const { patch, numstat } =
            to === undefined
              ? yield* worktreeDiff(root, base, options.path)
              : yield* refDiff(root, from, to, options.path);
          return {
            from: options.mergeBase === undefined ? (options.from ?? null) : base,
            to: options.to ?? null,
            isRepository: true,
            files: toDiffFiles(patch, numstat),
          };
        }).pipe(Effect.mapError(asRpcError)),

      branches: (scope) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(scope);
          if (root === null || !(yield* isRepository(root))) {
            return notRepositoryBranches;
          }
          return yield* listBranches(root);
        }).pipe(Effect.mapError(toRpcError)),

      createBranch: (scope, options) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          if (options.checkout) {
            yield* requireIdle(root);
          }
          yield* createBranch(root, options);
          return yield* listBranches(root);
        }).pipe(Effect.mapError(asRpcError)),

      checkout: (scope, branch) =>
        Effect.gen(function* () {
          const root = yield* repositoryRoot(scope);
          yield* requireIdle(root);
          yield* checkoutBranch(root, branch);
          return yield* listBranches(root);
        }).pipe(Effect.mapError(asRpcError)),

      /**
       * The refs that are actually there. The timeline's checkpoint list is a
       * fold of `thread.checkpoint.created`, so it still names refs removed
       * outside the app — a prune, a re-clone — and a caller intersects the
       * two rather than offering a restore that can only fail.
       */
      checkpoints: (projectId, threadId) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot({ projectId, threadId });
          if (root === null || !(yield* isRepository(root))) {
            return [];
          }
          return yield* checkpointStore.list({ threadId, workspaceRoot: root });
        }).pipe(
          Effect.mapError(
            (error) => new OpenAdeRpcError({ code: "internal", message: error.message }),
          ),
        ),
    });
  }),
);
