/**
 * A thread with its own worktree reads and writes there: `git.status`,
 * `git.diff`, `files.search`/`files.read` and `checkpoints.list` follow the
 * thread when it is named and stay on the project's root when it is not, and
 * checkpoints capture and restore inside the worktree while prune, run from
 * the project's root, still reaches the worktree thread's refs. Real `git
 * worktree add` in tmp directories.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
  type ProjectId,
  type ThreadId,
} from "@OpenAde/contracts/ids";
import type { ThreadWorktree } from "@OpenAde/contracts/git";
import type { OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { FileService, GitService, SettingsStore } from "../rpc/services";
import { make as checkpointStore } from "./CheckpointStore";
import { layer as fileLayer } from "./Files";
import { layer as gitLayer } from "./Git";
import { GhRunner } from "./GitHubCli";
import { WorktreesRoot } from "./Worktrees";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** A tmp directory by its real path: macOS hands out `/var`, git prints `/private/var`. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/**
 * A repository with one commit on `main`, and a worktree beside it on
 * `openade/fix` holding a file the main checkout does not have.
 */
const makeRepoWithWorktree = () => {
  const root = tempDir("openade-wt-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@openade.local");
  git(root, "config", "user.name", "OpenAde Test");
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const path = nodePath.join(tempDir("openade-wt-home-"), "fix");
  git(root, "worktree", "add", "-q", "-b", "openade/fix", path, "main");
  writeFileSync(nodePath.join(path, "only-in-worktree.ts"), "export const fix = 1\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "worktree work");
  const worktree: ThreadWorktree = { path, branch: "openade/fix", baseBranch: "main" };
  return { root, worktree };
};

const createdEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktree: ThreadWorktree | undefined,
): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    streamVersion: 1,
    occurredAt: new Date().toISOString(),
    actor: "user",
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Thread",
      settings: { model: "fake/model", runtimeMode: "full-access", interactionMode: "default" },
      ...(worktree === undefined ? {} : { worktree }),
    },
  }) as OrchestrationEvent;

/** Real sqlite + read models + both services, with a project and its threads. */
const stack = (root: string) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const now = new Date().toISOString();
    const addProject = (workspaceRoot: string) =>
      Effect.gen(function* () {
        const projectId = makeProjectId();
        yield* readModels.putProject({
          projectId,
          name: "test",
          workspaceRoot,
          createdAt: now,
          updatedAt: now,
          removed: false,
        });
        return projectId;
      });
    const addThread = (projectId: ProjectId, worktree?: ThreadWorktree) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        yield* readModels.putThread(foldThread([createdEvent(threadId, projectId, worktree)])!);
        return threadId;
      });
    const services = yield* Layer.build(
      Layer.mergeAll(gitLayer, fileLayer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            GhRunner.layer,
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            // No test here cuts a worktree, so nothing is created under it.
            Layer.succeed(WorktreesRoot, { path: nodePath.join(tmpdir(), "openade-no-worktrees") }),
          ),
        ),
      ),
    );
    return {
      projectId: yield* addProject(root),
      addProject,
      addThread,
      git: Context.get(services, GitService),
      files: Context.get(services, FileService),
    };
  });

describe("a thread's own workspace root", () => {
  it.live("git.status and git.diff read the worktree when the thread is named", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, worktree } = makeRepoWithWorktree();
        const { projectId, addThread, git: gitService } = yield* stack(root);
        const inWorktree = yield* addThread(projectId, worktree);
        const local = yield* addThread(projectId);

        writeFileSync(nodePath.join(worktree.path, "a.txt"), "one\nfrom the worktree\n");
        writeFileSync(nodePath.join(root, "main-only.txt"), "untracked on main\n");

        const own = yield* gitService.status({ projectId, threadId: inWorktree });
        expect(own.branch).toBe("openade/fix");
        expect(own.files.map((file) => file.path)).toEqual(["a.txt"]);

        // No thread, or a local one: the project's own checkout.
        for (const scope of [{ projectId }, { projectId, threadId: local }]) {
          const main = yield* gitService.status(scope);
          expect(main.branch).toBe("main");
          expect(main.files.map((file) => file.path)).toEqual(["main-only.txt"]);
        }

        const diff = yield* gitService.diff({ projectId, threadId: inWorktree }, {});
        expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
        expect(diff.files[0]?.additions).toBe(1);
        const mainDiff = yield* gitService.diff({ projectId }, {});
        expect(mainDiff.files.map((file) => file.path)).toEqual(["main-only.txt"]);
      }),
    ),
  );

  it.live("files.search and files.read follow the thread into its worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, worktree } = makeRepoWithWorktree();
        const { projectId, addThread, files } = yield* stack(root);
        const threadId = yield* addThread(projectId, worktree);

        const hits = yield* files.search({ projectId, threadId }, "only-in");
        expect(hits.map((hit) => hit.path)).toEqual(["only-in-worktree.ts"]);
        expect(yield* files.search({ projectId }, "only-in")).toEqual([]);

        const content = yield* files.read({ projectId, threadId }, "only-in-worktree.ts");
        expect(content.text).toContain("export const fix = 1");
        const outside = yield* files.read({ projectId }, "only-in-worktree.ts").pipe(Effect.exit);
        expect(outside._tag).toBe("Failure");
      }),
    ),
  );

  it.live("a thread of another project does not move the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, worktree } = makeRepoWithWorktree();
        const { projectId, addProject, addThread, git: gitService } = yield* stack(root);
        const elsewhere = yield* addProject(tempDir("openade-wt-other-"));
        const foreign = yield* addThread(elsewhere, worktree);

        const status = yield* gitService.status({ projectId, threadId: foreign });
        expect(status.branch).toBe("main");
      }),
    ),
  );

  it.live("checkpoints capture, list and restore inside the worktree; prune reaches them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, worktree } = makeRepoWithWorktree();
        const { projectId, addThread, git: gitService } = yield* stack(root);
        const threadId = yield* addThread(projectId, worktree);
        const file = nodePath.join(worktree.path, "only-in-worktree.ts");

        writeFileSync(file, "export const fix = 2\n");
        const checkpoint = yield* checkpointStore.capture({
          threadId,
          turnId: makeTurnId(),
          workspaceRoot: worktree.path,
        });
        writeFileSync(file, "export const fix = 3\n");

        const listed = yield* gitService.checkpoints(projectId, threadId);
        expect(listed.map((entry) => entry.checkpointId)).toEqual([checkpoint.checkpointId]);

        yield* checkpointStore.restore({ workspaceRoot: worktree.path, checkpoint });
        expect(readFileSync(file, "utf8")).toBe("export const fix = 2\n");
        // The worktree's own HEAD and index were left alone, and the main
        // checkout never saw any of it.
        expect(git(worktree.path, "rev-list", "--count", "HEAD").trim()).toBe("2");
        expect(git(root, "status", "--porcelain").trim()).toBe("");

        // Hidden refs are shared by every worktree of the repository, so the
        // project's root can prune a worktree thread even once it is gone.
        git(root, "worktree", "remove", "--force", worktree.path);
        yield* checkpointStore.prune({ threadId, workspaceRoot: root });
        expect(git(root, "for-each-ref", `refs/openade/checkpoints/${threadId}`).trim()).toBe("");
      }),
    ),
  );
});
