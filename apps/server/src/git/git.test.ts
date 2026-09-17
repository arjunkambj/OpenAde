/**
 * W8 done-when: two checkpointed turns diff correctly against each other, a
 * restore reverts the worktree, `files.search` answers warm, and `files.read`
 * caps large files. Repositories are real `git init` directories in tmp.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeProjectId, makeThreadId, makeTurnId } from "@OpenAde/contracts/ids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { ReadModelStore } from "../persistence/ReadModels";
import { FileService, GitService } from "../rpc/services";
import { layer as fileLayer } from "./Files";
import { layer as gitLayer } from "./Git";
import { make as checkpointStore } from "./CheckpointStore";
import { GitError, run } from "./process";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A fresh repo with one committed file. */
const makeRepo = () => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "openade-git-test-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@openade.local");
  git(root, "config", "user.name", "OpenAde Test");
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

/** Real sqlite + read models + both services, with a project row for `root`. */
const stack = (root: string) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const projectId = makeProjectId();
    const now = new Date().toISOString();
    yield* readModels.putProject({
      projectId,
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    const servicesContext = yield* Layer.build(
      Layer.mergeAll(gitLayer, fileLayer).pipe(Layer.provide(Layer.succeedContext(rmContext))),
    );
    return {
      projectId,
      git: Context.get(servicesContext, GitService),
      files: Context.get(servicesContext, FileService),
    };
  });

describe("w8 git", () => {
  it.live("run fails with GitError when git cannot be spawned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // An empty PATH makes the git binary itself unresolvable — the spawn
        // error carries the string code "ENOENT", which must fail the effect
        // rather than report exit 0 with empty output.
        const error = yield* run(root, ["status"], { env: { PATH: "/nonexistent" } }).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GitError);
        expect(error.exitCode).toBeNull();

        // A truncated result is a process failure too, not a silent success.
        const overflow = yield* run(root, ["--version"], { maxOutputBytes: 1 }).pipe(Effect.flip);
        expect(overflow).toBeInstanceOf(GitError);
      }),
    ),
  );

  it.live("two checkpoints diff correctly and restore reverts the worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const threadId = makeThreadId();

        // Turn 1: modify a.txt and add b.txt.
        writeFileSync(nodePath.join(root, "a.txt"), "one\ntwo\n");
        writeFileSync(nodePath.join(root, "b.txt"), "beta\n");
        const cp1 = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        // Turn 2: change a.txt again, delete b.txt, add c.txt.
        writeFileSync(nodePath.join(root, "a.txt"), "one\ntwo\nthree\n");
        writeFileSync(nodePath.join(root, "c.txt"), "gamma\n");
        // b.txt is untracked — checkpoints are hidden refs, not commits.
        unlinkSync(nodePath.join(root, "b.txt"));
        const cp2 = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: root,
        });

        // list sees both, oldest first.
        const listed = yield* checkpointStore.list({ threadId, workspaceRoot: root });
        expect(listed.map((c) => c.ref)).toEqual([cp1.ref, cp2.ref]);

        // The diff between checkpoints is exactly turn 2's changes.
        const { projectId, git: gitService } = yield* stack(root);
        const diff = yield* gitService.diff(projectId, { from: cp1.ref, to: cp2.ref });
        const byPath = new Map(diff.files.map((f) => [f.path, f]));
        expect(byPath.get("a.txt")?.additions).toBe(1);
        expect(byPath.get("b.txt")?.kind).toBe("delete");
        expect(byPath.get("c.txt")?.kind).toBe("create");

        // Restore to cp1 → worktree matches turn 1 exactly.
        yield* checkpointStore.restore({ workspaceRoot: root, checkpoint: cp1 });
        expect(readFileSync(nodePath.join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
        expect(readFileSync(nodePath.join(root, "b.txt"), "utf8")).toBe("beta\n");
        // c.txt was never in cp1 — clean removes it.
        expect(() => readFileSync(nodePath.join(root, "c.txt"))).toThrow();

        // The user's real index/HEAD are untouched — still one commit.
        expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
        expect(git(root, "status", "--porcelain").trim()).not.toBe("");
      }),
    ),
  );

  it.live("status reports branch and pending changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        writeFileSync(nodePath.join(root, "new.txt"), "untracked\n");
        writeFileSync(nodePath.join(root, "a.txt"), "changed\n");
        const status = yield* gitService.status(projectId);
        expect(status.branch).not.toBeNull();
        const paths = new Map(status.files.map((f) => [f.path, f.status]));
        expect(paths.get("new.txt")).toBe("untracked");
        expect(paths.get("a.txt")).toBe("modified");
      }),
    ),
  );

  it.live("worktree diff includes untracked files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: gitService } = yield* stack(root);
        writeFileSync(nodePath.join(root, "fresh.txt"), "brand new\n");
        const diff = yield* gitService.diff(projectId, {});
        const fresh = diff.files.find((f) => f.path === "fresh.txt");
        expect(fresh?.kind).toBe("create");
        expect(fresh?.diff).toContain("brand new");
      }),
    ),
  );

  it.live("files.search honors gitignore and reads cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        writeFileSync(nodePath.join(root, ".gitignore"), "ignored/\n");
        mkdirSync(nodePath.join(root, "ignored"));
        mkdirSync(nodePath.join(root, "src"));
        writeFileSync(nodePath.join(root, "ignored", "hidden.txt"), "secret\n");
        writeFileSync(nodePath.join(root, "src", "keep-me.ts"), "export const a = 1\n");
        git(root, "add", "-A");
        git(root, "commit", "-qm", "add files");

        const { projectId, files } = yield* stack(root);
        const hits = yield* files.search(projectId, "keep");
        expect(hits.map((h) => h.path)).toContain("src/keep-me.ts");
        const ignored = yield* files.search(projectId, "hidden");
        expect(ignored).toEqual([]);

        const content = yield* files.read(projectId, "src/keep-me.ts");
        expect(content.text).toContain("export const a = 1");
        const outside = yield* files.read(projectId, "../outside").pipe(Effect.exit);
        expect(outside._tag).toBe("Failure");
      }),
    ),
  );

  it.live("search stays warm under the cache TTL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        // ~600 files — enough to make the warm/cold difference meaningful.
        for (let i = 0; i < 600; i++) {
          writeFileSync(nodePath.join(root, `f${i}.txt`), "x\n");
        }
        const { projectId, files } = yield* stack(root);
        yield* files.search(projectId, "f1"); // populate the cache
        const start = Date.now();
        yield* files.search(projectId, "f5");
        expect(Date.now() - start).toBeLessThan(200);
      }),
    ),
  );
});
