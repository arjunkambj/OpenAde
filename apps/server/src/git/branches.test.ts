/**
 * The branch RPCs against real repositories in tmp directories: listing local
 * and remote branches (the remote is a local bare repository), the default
 * branch fallbacks, cutting a branch that tracks nothing, switching with the
 * dirty-tree and running-turn guards, name validation, and the merge-base
 * diff behind the Changes pane's "branch against base" scope.
 */
import { describe, expect, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
  makeEventId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { ThreadWorktree } from "@poseidon/contracts/git";
import type { OrchestrationEvent } from "@poseidon/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { GitService, SettingsStore } from "../rpc/services";
import { layer as gitLayer } from "./Git";
import { GhRunner } from "./GitHubCli";
import { WorktreesRoot } from "./Worktrees";

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A tmp directory by its real path: macOS hands out `/var`, git prints `/private/var`. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/** CI has no global identity, so every repository gets its own. */
const identify = (root: string) => {
  git(root, "config", "user.email", "test@poseidon.local");
  git(root, "config", "user.name", "Poseidon Test");
};

/** A repository with one commit of `a.txt` on `branch`. */
const makeRepo = (branch = "main") => {
  const root = tempDir("poseidon-branch-repo-");
  git(root, "init", "-q", "-b", branch);
  identify(root);
  writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

const commitFile = (root: string, name: string, text: string) => {
  writeFileSync(nodePath.join(root, name), text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", `add ${name}`);
};

/** A bare repository standing in for the remote, added to `root` as `origin`. */
const addBareRemote = (root: string, headBranch = "main") => {
  const bare = tempDir("poseidon-branch-remote-");
  git(bare, "init", "-q", "--bare", "-b", headBranch);
  git(root, "remote", "add", "origin", bare);
  return bare;
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

/** Real sqlite + read models + the git layer, with a project on `root`. */
const stack = (root: string) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
    yield* runMigrations.pipe(Effect.provide(sqlite));
    const rmContext = yield* Layer.build(ReadModelStore.layer.pipe(Layer.provide(sqlite)));
    const readModels = Context.get(rmContext, ReadModelStore);
    const now = new Date().toISOString();
    const projectId = makeProjectId();
    yield* readModels.putProject({
      projectId,
      name: "test",
      workspaceRoot: root,
      createdAt: now,
      updatedAt: now,
      removed: false,
    });
    /** A thread with a turn in flight, local unless given a worktree. */
    const addRunningThread = (worktree?: ThreadWorktree) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        const doc = foldThread([createdEvent(threadId, projectId, worktree)])!;
        yield* readModels.putThread({
          ...doc,
          status: "running",
          currentTurn: {
            turnId: makeTurnId(),
            input: { text: "go", attachments: [], mentions: [] },
          },
        });
        return threadId;
      });
    const services = yield* Layer.build(
      gitLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(rmContext),
            GhRunner.layer,
            SettingsStore.layer.pipe(Layer.provide(sqlite)),
            // No test here cuts a worktree, so nothing is created under it.
            Layer.succeed(WorktreesRoot, {
              path: nodePath.join(tmpdir(), "poseidon-no-worktrees"),
            }),
          ),
        ),
      ),
    );
    return { projectId, addRunningThread, git: Context.get(services, GitService) };
  });

const summary = (list: {
  readonly branches: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
}) => list.branches.map((branch) => `${branch.kind}:${branch.name}`);

describe("git.branches", () => {
  it.live("lists local and remote branches, their upstreams and their worktrees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        addBareRemote(root);
        git(root, "push", "-q", "-u", "origin", "main");
        git(root, "branch", "release");
        git(root, "push", "-q", "origin", "release");
        git(root, "branch", "-D", "release");
        git(root, "branch", "feature");
        const elsewhere = nodePath.join(tempDir("poseidon-branch-wt-"), "wt");
        git(root, "worktree", "add", "-q", "-b", "in-worktree", elsewhere, "main");
        const { projectId, git: service } = yield* stack(root);

        const list = yield* service.branches({ projectId });
        expect(list.isRepository).toBe(true);
        expect(list.current).toBe("main");
        expect(list.remotes).toEqual(["origin"]);
        expect(summary(list)).toEqual([
          "local:feature",
          "local:in-worktree",
          "local:main",
          "remote:origin/main",
          "remote:origin/release",
        ]);
        const byName = new Map(list.branches.map((branch) => [branch.name, branch]));
        expect(byName.get("main")).toEqual({
          name: "main",
          kind: "local",
          isCurrent: true,
          upstream: "origin/main",
        });
        expect(byName.get("feature")?.upstream).toBeUndefined();
        expect(byName.get("in-worktree")?.worktreePath).toBe(elsewhere);
      }),
    ),
  );

  it.live("answers isRepository: false for a folder git does not track", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projectId, git: service } = yield* stack(tempDir("poseidon-branch-plain-"));
        const list = yield* service.branches({ projectId });
        expect(list).toEqual({
          isRepository: false,
          current: null,
          defaultBranch: null,
          remotes: [],
          branches: [],
        });
      }),
    ),
  );
});

describe("the default branch", () => {
  it.live("is the remote's HEAD when the remote names one, over a local main", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = makeRepo("trunk");
        const bare = addBareRemote(source, "trunk");
        git(source, "push", "-q", "origin", "trunk");
        const clone = nodePath.join(tempDir("poseidon-branch-clone-"), "clone");
        execFileSync("git", ["clone", "-q", bare, clone]);
        identify(clone);
        git(clone, "branch", "main");
        const { projectId, git: service } = yield* stack(clone);

        const list = yield* service.branches({ projectId });
        expect(list.defaultBranch).toBe("trunk");
        expect(summary(list)).toContain("remote:origin/trunk");
        expect(summary(list)).not.toContain("remote:origin/HEAD");
      }),
    ),
  );

  it.live("is the remote-tracking name when no local branch has the remote HEAD's name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = makeRepo("main");
        git(source, "switch", "-q", "-c", "develop");
        const bare = addBareRemote(source, "main");
        git(source, "push", "-q", "origin", "main", "develop");
        const clone = nodePath.join(tempDir("poseidon-branch-clone-"), "clone");
        // Only develop is checked out locally; main exists only as origin/main.
        execFileSync("git", ["clone", "-q", "-b", "develop", bare, clone]);
        identify(clone);
        const { projectId, git: service } = yield* stack(clone);

        const list = yield* service.branches({ projectId });
        expect(list.defaultBranch).toBe("origin/main");
        const base = list.defaultBranch ?? "";
        // It is a base the Changes pane can diff against.
        const diff = yield* service.diff({ projectId }, { mergeBase: base });
        expect(diff.files).toEqual([]);
      }),
    ),
  );

  it.live("falls back to a local main or master", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("master");
        git(root, "switch", "-q", "-c", "feature");
        const { projectId, git: service } = yield* stack(root);
        expect((yield* service.branches({ projectId })).defaultBranch).toBe("master");
      }),
    ),
  );

  it.live("falls back to init.defaultBranch when that branch exists, then to the current one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo("develop");
        git(root, "config", "init.defaultBranch", "develop");
        git(root, "switch", "-q", "-c", "feature");
        const { projectId, git: service } = yield* stack(root);
        expect((yield* service.branches({ projectId })).defaultBranch).toBe("develop");

        const lone = makeRepo("feature");
        git(lone, "config", "init.defaultBranch", "develop");
        const other = yield* stack(lone);
        const list = yield* other.git.branches({ projectId: other.projectId });
        expect(list.defaultBranch).toBe("feature");
      }),
    ),
  );
});

describe("git.branch.create", () => {
  it.live("cuts a branch without switching to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: service } = yield* stack(root);
        const list = yield* service.createBranch({ projectId }, { name: "topic", checkout: false });
        expect(list.current).toBe("main");
        expect(summary(list)).toContain("local:topic");
      }),
    ),
  );

  it.live("cuts a branch from origin/main and switches to it, tracking nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        addBareRemote(root);
        git(root, "push", "-q", "-u", "origin", "main");
        const { projectId, git: service } = yield* stack(root);

        const list = yield* service.createBranch(
          { projectId },
          { name: "poseidon/fix-login", from: "origin/main", checkout: true },
        );
        expect(list.current).toBe("poseidon/fix-login");
        const created = list.branches.find((branch) => branch.name === "poseidon/fix-login");
        expect(created?.upstream).toBeUndefined();
        // The first push must never land on main: no upstream at all.
        expect(() => git(root, "rev-parse", "--abbrev-ref", "poseidon/fix-login@{u}")).toThrow();
      }),
    ),
  );

  it.live("rejects names git would read as an option or refuse", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        const { projectId, git: service } = yield* stack(root);
        for (const name of ["-x", "a..b", "has space"]) {
          const error = yield* service
            .createBranch({ projectId }, { name, checkout: false })
            .pipe(Effect.flip);
          expect(error.code, name).toBe("invalid");
        }
        expect(git(root, "branch", "--list").trim()).toBe("* main");
      }),
    ),
  );
});

describe("git.checkout", () => {
  it.live("switches on a clean tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "branch", "feature");
        const { projectId, git: service } = yield* stack(root);
        const list = yield* service.checkout({ projectId }, "feature");
        expect(list.current).toBe("feature");
        expect(git(root, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");
      }),
    ),
  );

  it.live("refuses while a tracked file has uncommitted changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "branch", "feature");
        writeFileSync(nodePath.join(root, "a.txt"), "one\nedited\n");
        const { projectId, git: service } = yield* stack(root);
        const error = yield* service.checkout({ projectId }, "feature").pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toContain("uncommitted changes");
        expect(git(root, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
      }),
    ),
  );

  it.live("switches with only an untracked file present, and carries it along", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "branch", "feature");
        writeFileSync(nodePath.join(root, "session.local.json"), "{}\n");
        const { projectId, git: service } = yield* stack(root);
        const list = yield* service.checkout({ projectId }, "feature");
        expect(list.current).toBe("feature");
        expect(git(root, "status", "--porcelain").trim()).toBe("?? session.local.json");
      }),
    ),
  );

  it.live("checks out a remote-only branch as a local branch tracking it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        addBareRemote(root);
        git(root, "branch", "release");
        git(root, "push", "-q", "origin", "main", "release");
        git(root, "branch", "-D", "release");
        const { projectId, git: service } = yield* stack(root);

        const list = yield* service.checkout({ projectId }, "origin/release");
        expect(list.current).toBe("release");
        const release = list.branches.find((branch) => branch.name === "release");
        expect(release).toEqual({
          name: "release",
          kind: "local",
          isCurrent: true,
          upstream: "origin/release",
        });
      }),
    ),
  );

  it.live("refuses while a turn runs in the same root, and not for a worktree's turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "branch", "feature");
        const path = nodePath.join(tempDir("poseidon-branch-wt-"), "wt");
        git(root, "worktree", "add", "-q", "-b", "poseidon/wt", path, "main");
        const { projectId, addRunningThread, git: service } = yield* stack(root);

        // A turn in another worktree writes elsewhere: the project root may switch.
        yield* addRunningThread({ path, branch: "poseidon/wt", baseBranch: "main" });
        expect((yield* service.checkout({ projectId }, "feature")).current).toBe("feature");

        yield* addRunningThread();
        const error = yield* service.checkout({ projectId }, "main").pipe(Effect.flip);
        expect(error.code).toBe("conflict");
        expect(error.message).toContain("A turn is running");
        const cut = yield* service
          .createBranch({ projectId }, { name: "other", checkout: true })
          .pipe(Effect.flip);
        expect(cut.code).toBe("conflict");
        expect(git(root, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature");
        // Cutting without switching leaves the running turn's tree alone.
        const list = yield* service.createBranch({ projectId }, { name: "other", checkout: false });
        expect(summary(list)).toContain("local:other");
      }),
    ),
  );
});

describe("git.diff against a merge base", () => {
  it.live("shows the branch's commits and uncommitted work, not the base's later commits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = makeRepo();
        git(root, "branch", "feature");
        commitFile(root, "main-later.txt", "landed on main after the fork\n");
        git(root, "switch", "-q", "feature");
        commitFile(root, "feature.txt", "branch work\n");
        writeFileSync(nodePath.join(root, "a.txt"), "one\nuncommitted\n");
        writeFileSync(nodePath.join(root, "new.txt"), "untracked\n");
        const { projectId, git: service } = yield* stack(root);

        const diff = yield* service.diff({ projectId }, { mergeBase: "main" });
        expect(diff.files.map((file) => file.path).sort()).toEqual([
          "a.txt",
          "feature.txt",
          "new.txt",
        ]);
        expect(diff.from).toBe(git(root, "merge-base", "HEAD", "main").trim());

        // Against main's tip instead, main's later commit reads as deleted.
        const tip = yield* service.diff({ projectId }, { from: "main" });
        expect(tip.files.map((file) => file.path)).toContain("main-later.txt");

        const bad = yield* service
          .diff({ projectId }, { mergeBase: "--output=x" })
          .pipe(Effect.flip);
        expect(bad.code).toBe("invalid");
      }),
    ),
  );
});
