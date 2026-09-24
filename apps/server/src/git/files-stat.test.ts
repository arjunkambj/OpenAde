/**
 * `files.stat` reports a path only when it exists strictly inside the scope's
 * workspace root: relative or absolute, through in-root symlinks but never out
 * through one, never past `..`, and never failing the batch for a bad path.
 * Real directories in tmp, resolved through realpath and also by the alias
 * macOS hands out, over the real read models and file service.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { makeEventId, makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type { ProjectId, ThreadId } from "@OpenAde/contracts/ids";
import type { ThreadWorktree } from "@OpenAde/contracts/git";
import type { OrchestrationEvent } from "@OpenAde/contracts/orchestration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { foldThread } from "../orchestration/state";
import { runMigrations } from "../persistence/Migrations";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { FileService } from "../rpc/services";
import { layer as fileLayer } from "./Files";
import { statWorkspacePaths } from "./stat";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(nodePath.join(tmpdir(), prefix)));

/**
 * A workspace with a file, a nested directory, an in-root symlink, and a
 * symlinked file and directory that both lead out of it.
 */
const makeWorkspace = () => {
  const root = tempDir("openade-stat-root-");
  const outside = tempDir("openade-stat-outside-");
  writeFileSync(nodePath.join(outside, "secret.txt"), "do not report\n");
  mkdirSync(nodePath.join(root, "src", "lib"), { recursive: true });
  writeFileSync(nodePath.join(root, "README.md"), "# hi\n");
  writeFileSync(nodePath.join(root, "src", "lib", "a.ts"), "export const a = 1\n");
  symlinkSync("src/lib/a.ts", nodePath.join(root, "alias.ts"));
  symlinkSync(nodePath.join(outside, "secret.txt"), nodePath.join(root, "leak.txt"));
  symlinkSync(outside, nodePath.join(root, "linked"));
  return { root, outside };
};

const createdEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  worktree: ThreadWorktree,
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
      worktree,
    },
  }) as OrchestrationEvent;

/** Real sqlite, read models and the file service, with a project at `root`. */
const stack = (root: string) =>
  Effect.gen(function* () {
    const sqlite = Layer.succeedContext(yield* Layer.build(sqliteTestLayer()));
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
    const addWorktreeThread = (worktree: ThreadWorktree) =>
      Effect.gen(function* () {
        const threadId = makeThreadId();
        yield* readModels.putThread(foldThread([createdEvent(threadId, projectId, worktree)])!);
        return threadId;
      });
    const services = yield* Layer.build(
      fileLayer.pipe(Layer.provide(Layer.succeedContext(rmContext))),
    );
    return { projectId, addWorktreeThread, files: Context.get(services, FileService) };
  });

describe("files.stat", () => {
  it.live("reports files and directories inside the root, by relative path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = makeWorkspace();
        const { projectId, files } = yield* stack(root);
        const found = yield* files.stat({ projectId }, ["README.md", "src/lib", "./src/lib/a.ts"]);
        expect(found).toEqual([
          {
            path: "README.md",
            relativePath: "README.md",
            absolutePath: nodePath.join(root, "README.md"),
            isDirectory: false,
          },
          {
            path: "src/lib",
            relativePath: "src/lib",
            absolutePath: nodePath.join(root, "src", "lib"),
            isDirectory: true,
          },
          {
            path: "./src/lib/a.ts",
            relativePath: "src/lib/a.ts",
            absolutePath: nodePath.join(root, "src", "lib", "a.ts"),
            isDirectory: false,
          },
        ]);
      }),
    ),
  );

  it.live("accepts an absolute path only when it lies inside the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, outside } = makeWorkspace();
        const { projectId, files } = yield* stack(root);
        const inside = nodePath.join(root, "src", "lib", "a.ts");
        const found = yield* files.stat({ projectId }, [
          inside,
          nodePath.join(outside, "secret.txt"),
          "/etc/hosts",
          root,
        ]);
        expect(found.map((entry) => [entry.path, entry.relativePath])).toEqual([
          [inside, "src/lib/a.ts"],
        ]);
      }),
    ),
  );

  it.live("never reports a path that escapes, lexically or through a symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, outside } = makeWorkspace();
        const { projectId, files } = yield* stack(root);
        const escapee = nodePath.basename(outside);
        const found = yield* files.stat({ projectId }, [
          `../${escapee}/secret.txt`,
          `src/../../${escapee}/secret.txt`,
          "..",
          ".",
          "leak.txt",
          "linked",
          "linked/secret.txt",
          "alias.ts",
        ]);
        // Only the symlink that stays inside the root survives, by its own name.
        expect(found).toEqual([
          {
            path: "alias.ts",
            relativePath: "alias.ts",
            absolutePath: nodePath.join(root, "alias.ts"),
            isDirectory: false,
          },
        ]);
      }),
    ),
  );

  it.live(
    "leaves a missing or unreadable path out without failing the batch, asking each once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = makeWorkspace();
          const locked = nodePath.join(root, "locked");
          mkdirSync(locked);
          writeFileSync(nodePath.join(locked, "inner.ts"), "export {}\n");
          chmodSync(locked, 0o000);
          yield* Effect.addFinalizer(() => Effect.sync(() => chmodSync(locked, 0o755)));
          const { projectId, files } = yield* stack(root);
          const found = yield* files.stat({ projectId }, [
            "missing.ts",
            "README.md",
            "src/lib/a.ts/not-a-dir",
            "locked/inner.ts",
            "README.md",
            "bad\0name",
          ]);
          expect(found.map((entry) => entry.path)).toEqual(["README.md"]);
          expect(yield* files.stat({ projectId }, [])).toEqual([]);
          expect(yield* files.stat({ projectId: makeProjectId() }, ["README.md"])).toEqual([]);
        }),
      ),
  );

  it.live("reads the thread's worktree when the scope names the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = makeWorkspace();
        const worktreePath = tempDir("openade-stat-worktree-");
        writeFileSync(nodePath.join(worktreePath, "only-here.ts"), "export {}\n");
        const { projectId, addWorktreeThread, files } = yield* stack(root);
        const threadId = yield* addWorktreeThread({
          path: worktreePath,
          branch: "openade/stat",
          baseBranch: "main",
        });

        const own = yield* files.stat({ projectId, threadId }, ["only-here.ts", "README.md"]);
        expect(own.map((entry) => entry.absolutePath)).toEqual([
          nodePath.join(worktreePath, "only-here.ts"),
        ]);
        const project = yield* files.stat({ projectId }, ["only-here.ts", "README.md"]);
        expect(project.map((entry) => entry.path)).toEqual(["README.md"]);
        // The project's root is outside the worktree, so its absolute path is too.
        const crossed = yield* files.stat({ projectId, threadId }, [
          nodePath.join(root, "README.md"),
        ]);
        expect(crossed).toEqual([]);
      }),
    ),
  );
});

describe("statWorkspacePaths", () => {
  it("matches a root and an absolute path written through a symlinked alias", async () => {
    const { root } = makeWorkspace();
    const aliasHome = tempDir("openade-stat-alias-");
    const aliasRoot = nodePath.join(aliasHome, "workspace");
    symlinkSync(root, aliasRoot);

    // The root as the project stores it may be the alias; a harness may
    // report the canonical path. Both name the same file.
    const viaAlias = await statWorkspacePaths(aliasRoot, [
      nodePath.join(root, "README.md"),
      nodePath.join(aliasRoot, "src", "lib", "a.ts"),
    ]);
    expect(viaAlias.map((entry) => [entry.relativePath, entry.absolutePath])).toEqual([
      ["README.md", nodePath.join(aliasRoot, "README.md")],
      ["src/lib/a.ts", nodePath.join(aliasRoot, "src", "lib", "a.ts")],
    ]);
  });

  it("answers nothing for a root that does not exist", async () => {
    const missing = nodePath.join(tempDir("openade-stat-gone-"), "nope");
    expect(await statWorkspacePaths(missing, ["README.md"])).toEqual([]);
  });

  it("is not fooled by a sibling directory that shares the root's name as a prefix", async () => {
    const { root } = makeWorkspace();
    const sibling = `${root}-sibling`;
    mkdirSync(sibling);
    writeFileSync(nodePath.join(sibling, "x.ts"), "export {}\n");
    expect(await statWorkspacePaths(root, [nodePath.join(sibling, "x.ts")])).toEqual([]);
    // A file whose name merely starts with two dots is still inside.
    writeFileSync(nodePath.join(root, "..notes"), "\n");
    expect((await statWorkspacePaths(root, ["..notes"])).map((e) => e.relativePath)).toEqual([
      "..notes",
    ]);
  });
});
