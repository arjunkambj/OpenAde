/**
 * The real `GitService` behind the `git.status`/`git.diff` RPCs: argv-form git
 * over `process.ts`, porcelain-v2 parsing for status, and unified patches split
 * per file for the changes pane. A missing `projectId` or a non-repository
 * root answers with empty results rather than an RPC error — the pane renders
 * "not a git repo" the same way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type {
  FileSearchResult,
  GitDiff,
  GitDiffFile,
  GitFileChange,
  GitStatus,
} from "@OpenAde/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";

import { ReadModelStore } from "../persistence/ReadModels";
import { GitService } from "../rpc/services";
import { GitError, run } from "./process";

const toRpcError = (error: GitError) =>
  new OpenAdeRpcError({ code: "internal", message: error.message });

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

/** `diff --numstat` rows: `added\tdeleted\tpath`. Binary rows are `-\t-`. */
const parseNumstat = (stdout: string): Map<string, { added: number; deleted: number }> => {
  const map = new Map<string, { added: number; deleted: number }>();
  for (const line of stdout.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (match === null) continue;
    map.set(match[3]!, {
      added: match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10),
      deleted: match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10),
    });
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
    const tempIndex = nodePath.join(
      mkdtempSync(nodePath.join(tmpdir(), "openade-index-")),
      "index",
    );
    const env = { GIT_INDEX_FILE: tempIndex };
    try {
      yield* run(cwd, ["read-tree", base], { env }).pipe(
        Effect.catch(() => Effect.void), // unborn HEAD: empty temp index is fine
      );
      const untracked = yield* run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
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
      const numstat = yield* run(cwd, ["diff", "--numstat", base, ...pathspec], { env });
      return { patch: patch.stdout, numstat: numstat.stdout };
    } finally {
      rmSync(tempIndex, { force: true });
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
    const numstat = yield* run(cwd, ["diff", "--numstat", ...range, ...pathspec]);
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

const notRepo: GitDiff = { from: null, to: null, files: [] };

/**
 * `from`/`to` land in flag position on the `git diff` argv — a value like
 * `--output=/path` would write the diff wherever the server user can. A ref
 * is letters, digits, `.`, `_`, `/`, `-` (branch names, SHAs, hidden refs);
 * anything else, or a leading `-`, is rejected before git ever sees it.
 */
const REF_ARG = /^[A-Za-z0-9._/-]+$/;
const validRef = (value: string, name: string): Effect.Effect<string, OpenAdeRpcError> =>
  !value.startsWith("-") && REF_ARG.test(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new OpenAdeRpcError({ code: "invalid", message: `invalid ${name} ref: ${value}` }),
      );

export const layer = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;

    const workspaceRoot = (projectId: ProjectId) =>
      readModels.getProjectDoc(projectId).pipe(
        Effect.map((doc) => doc?.workspaceRoot ?? null),
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

    const isRepo = (cwd: string) =>
      run(cwd, ["rev-parse", "--is-inside-work-tree"], { allowNonZeroExit: true }).pipe(
        Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
      );

    return GitService.of({
      status: (projectId) =>
        Effect.gen(function* () {
          const root = yield* workspaceRoot(projectId);
          if (root === null || !(yield* isRepo(root))) {
            return { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
          }
          const result = yield* run(root, [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
          ]);
          return parseStatus(result.stdout);
        }).pipe(Effect.mapError(toRpcError)),

      diff: (projectId, options) =>
        Effect.gen(function* () {
          const from = yield* validRef(options.from ?? "HEAD", "from");
          const to = options.to === undefined ? undefined : yield* validRef(options.to, "to");
          const root = yield* workspaceRoot(projectId);
          if (root === null || !(yield* isRepo(root))) {
            return { ...notRepo, from: options.from ?? null, to: options.to ?? null };
          }
          const { patch, numstat } =
            to === undefined
              ? yield* worktreeDiff(root, from, options.path)
              : yield* refDiff(root, from, to, options.path);
          return {
            from: options.from ?? null,
            to: options.to ?? null,
            files: toDiffFiles(patch, numstat),
          };
        }).pipe(
          Effect.mapError((error) =>
            error instanceof OpenAdeRpcError ? error : toRpcError(error),
          ),
        ),
    });
  }),
);

export type { FileSearchResult };
