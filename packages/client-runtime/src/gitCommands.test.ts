/**
 * The git writes over a stubbed RPC client. What the start screen relies on:
 * the setup atom shows the output while the script is still running, a
 * finished run resolves with everything it printed and its exit status, and
 * the writes send the payload the server expects. What the git actions
 * control relies on: a commit or a push refetches the status it shows.
 */

import { describe, expect, it } from "@effect/vitest";
import type { GitBranchList, WorktreeSetupFrame } from "@OpenAde/contracts/git";
import { makeProjectId, makeThreadId } from "@OpenAde/contracts/ids";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import type * as Atom from "effect/unstable/reactivity/Atom";

import { makeRuntime } from "./atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type OpenAdeRpcClient,
} from "./connection";
import {
  emptySetupProgress,
  makeGitCommands,
  scanSetupFrame,
  type WorktreeSetupProgress,
} from "./gitCommands";
import { makeGitAtoms } from "./gitAtoms";

const WORKTREE = { path: "/home/me/.openade/worktrees/app/fix-login", branch: "openade/fix-login" };

interface Calls {
  readonly create: Array<unknown>;
  readonly setup: Array<unknown>;
  readonly remove: Array<unknown>;
  readonly branches: Array<unknown>;
  readonly commit: Array<unknown>;
  readonly push: Array<unknown>;
  readonly pullRequest: Array<unknown>;
  readonly status: Array<unknown>;
}

const branchList = (branches: ReadonlyArray<string>): GitBranchList => ({
  isRepository: true,
  current: "main",
  defaultBranch: "main",
  remotes: [],
  branches: branches.map((name) => ({ name, kind: "local" as const, isCurrent: name === "main" })),
});

const fakeClient = (
  calls: Calls,
  frames: Queue.Queue<WorktreeSetupFrame, Cause.Done>,
): OpenAdeRpcClient =>
  new Proxy({} as OpenAdeRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "git.worktree.create":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.create.push(payload);
              return { ...WORKTREE, baseBranch: "main" };
            });
        case "git.worktree.setup":
          return (payload: unknown) => {
            calls.setup.push(payload);
            return Stream.fromQueue(frames);
          };
        case "git.worktree.remove":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.remove.push(payload);
              return {};
            });
        case "git.branches":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.branches.push(payload);
              // A create adds a branch; the list the second fetch sees has it.
              return branchList(
                calls.create.length > calls.remove.length ? ["main", WORKTREE.branch] : ["main"],
              );
            });
        case "git.commit":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.commit.push(payload);
              return { sha: "abc1234def", subject: "Fix the login", branch: WORKTREE.branch };
            });
        case "git.push":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.push.push(payload);
              return { remote: "origin", branch: WORKTREE.branch, setUpstream: true };
            });
        case "git.pullRequest.create":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.pullRequest.push(payload);
              return { url: "https://github.com/acme/app/pull/7", created: true };
            });
        case "git.status":
          return (payload: unknown) =>
            Effect.sync(() => {
              calls.status.push(payload);
              // A commit leaves nothing behind; a push leaves nothing ahead.
              return {
                branch: WORKTREE.branch,
                upstream: calls.push.length > 0 ? `origin/${WORKTREE.branch}` : null,
                ahead: calls.commit.length > calls.push.length ? 1 : 0,
                behind: 0,
                isRepository: true,
                files:
                  calls.commit.length > 0
                    ? []
                    : [{ path: "src/login.ts", status: "modified", staged: false }],
              };
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const setupWith = Effect.gen(function* () {
  const calls: Calls = {
    create: [],
    setup: [],
    remove: [],
    branches: [],
    commit: [],
    push: [],
    pullRequest: [],
    status: [],
  };
  const frames = yield* Queue.unbounded<WorktreeSetupFrame, Cause.Done>();
  const stateRef = yield* SubscriptionRef.make<ConnectionState>({
    status: "connected",
    serverInstanceId: null,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Connection, {
      client: Effect.succeed(fakeClient(calls, frames)),
      state: stateRef,
    }),
    Layer.succeed(ConnectionStateRef, stateRef),
  );
  const base = makeRuntime(layer);
  const git = makeGitAtoms(base.runtime);
  return {
    calls,
    frames,
    registry: AtomRegistry.make(),
    git,
    ...makeGitCommands(base.runtime, git),
  };
});

/** Resolves on the first result matching the predicate — no timers in logic. */
const awaitResult = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (result: AsyncResult.AsyncResult<A, E>) => boolean,
): Promise<AsyncResult.AsyncResult<A, E>> =>
  new Promise((resolve) => {
    const check = (result: AsyncResult.AsyncResult<A, E>) => {
      if (predicate(result)) {
        unmount();
        resolve(result);
      }
    };
    const unmount = registry.subscribe(atom, check);
    check(registry.get(atom));
  });

describe("scanSetupFrame", () => {
  it("collects output in order and ends on the exit status", () => {
    const frames: ReadonlyArray<WorktreeSetupFrame> = [
      { kind: "output", text: "installing\n" },
      { kind: "output", text: "warn: peer dep\n" },
      { kind: "exit", exitCode: 3 },
    ];
    expect(frames.reduce(scanSetupFrame, emptySetupProgress)).toEqual({
      output: "installing\nwarn: peer dep\n",
      exit: { code: 3 },
      skipped: false,
    });
  });

  it("keeps the signal of a killed script", () => {
    expect(
      scanSetupFrame(emptySetupProgress, { kind: "exit", exitCode: null, signal: "SIGTERM" }),
    ).toEqual({ output: "", exit: { code: null, signal: "SIGTERM" }, skipped: false });
  });

  it("marks a project without a script as skipped", () => {
    expect(scanSetupFrame(emptySetupProgress, { kind: "skipped" })).toEqual({
      output: "",
      exit: null,
      skipped: true,
    });
  });
});

describe("git commands", () => {
  it.live("the setup atom shows output before the script has finished", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, frames, registry, worktreeSetupAtom } = yield* setupWith;
      registry.mount(worktreeSetupAtom);
      registry.set(worktreeSetupAtom, { projectId, path: WORKTREE.path });

      yield* Queue.offer(frames, { kind: "output", text: "installing\n" });
      const partial = yield* Effect.promise(() =>
        awaitResult(
          registry,
          worktreeSetupAtom,
          (result) => AsyncResult.isSuccess(result) && result.value.output === "installing\n",
        ),
      );
      // Still running: no exit yet, and the atom says it is waiting for more.
      expect(AsyncResult.isSuccess(partial) && partial.value.exit).toBeNull();
      expect(partial.waiting).toBe(true);

      yield* Queue.offer(frames, { kind: "output", text: "done\n" });
      yield* Queue.offer(frames, { kind: "exit", exitCode: 0 });
      yield* Queue.end(frames);
      const finished = yield* Effect.promise(() =>
        awaitResult(registry, worktreeSetupAtom, (result) => !result.waiting),
      );
      expect(AsyncResult.isSuccess(finished) && finished.value).toEqual<WorktreeSetupProgress>({
        output: "installing\ndone\n",
        exit: { code: 0 },
        skipped: false,
      });
      expect(calls.setup).toEqual([{ projectId, path: WORKTREE.path }]);
    }),
  );

  it.live("a create sends the name and base, and refetches the project's branches", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, git, worktreeCreateAtom } = yield* setupWith;
      const branchesAtom = git.gitBranchesAtom({ projectId });
      registry.mount(branchesAtom);
      yield* Effect.promise(() =>
        awaitResult(registry, branchesAtom, (result) => AsyncResult.isSuccess(result)),
      );

      registry.mount(worktreeCreateAtom);
      registry.set(worktreeCreateAtom, { projectId, name: "Fix the login", baseBranch: "main" });
      const created = yield* Effect.promise(() =>
        awaitResult(registry, worktreeCreateAtom, (result) => AsyncResult.isSuccess(result)),
      );
      expect(AsyncResult.isSuccess(created) && created.value.branch).toBe(WORKTREE.branch);
      expect(calls.create).toEqual([{ projectId, name: "Fix the login", baseBranch: "main" }]);

      const refreshed = yield* Effect.promise(() =>
        awaitResult(
          registry,
          branchesAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.branches.length === 2,
        ),
      );
      expect(AsyncResult.isSuccess(refreshed)).toBe(true);
    }),
  );

  it.live("a remove sends force only when asked", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const { calls, registry, worktreeRemoveAtom } = yield* setupWith;
      registry.mount(worktreeRemoveAtom);
      registry.set(worktreeRemoveAtom, { projectId, path: WORKTREE.path, force: true });
      yield* Effect.promise(() =>
        awaitResult(registry, worktreeRemoveAtom, (result) => AsyncResult.isSuccess(result)),
      );
      registry.set(worktreeRemoveAtom, { projectId, path: WORKTREE.path });
      yield* Effect.promise(() =>
        awaitResult(
          registry,
          worktreeRemoveAtom,
          (result) => AsyncResult.isSuccess(result) && !result.waiting && calls.remove.length === 2,
        ),
      );
      expect(calls.remove).toEqual([
        { projectId, path: WORKTREE.path, force: true },
        { projectId, path: WORKTREE.path },
      ]);
    }),
  );

  it.live("a commit sends the chosen paths and refetches the thread's status", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, git, gitCommitAtom } = yield* setupWith;
      const statusAtom = git.gitStatusAtom({ projectId, threadId });
      registry.mount(statusAtom);
      yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.files.length === 1,
        ),
      );

      registry.mount(gitCommitAtom);
      registry.set(gitCommitAtom, {
        projectId,
        threadId,
        message: "Fix the login",
        paths: ["src/login.ts"],
      });
      const committed = yield* Effect.promise(() =>
        awaitResult(registry, gitCommitAtom, (result) => AsyncResult.isSuccess(result)),
      );
      expect(AsyncResult.isSuccess(committed) && committed.value.sha).toBe("abc1234def");
      expect(calls.commit).toEqual([
        { projectId, threadId, message: "Fix the login", paths: ["src/login.ts"] },
      ]);

      const refreshed = yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.files.length === 0 &&
            result.value.value.ahead === 1,
        ),
      );
      expect(AsyncResult.isSuccess(refreshed)).toBe(true);
    }),
  );

  it.live("a push refetches the status, and a pull request sends its title and body", () =>
    Effect.gen(function* () {
      const projectId = makeProjectId();
      const threadId = makeThreadId();
      const { calls, registry, git, gitPushAtom, gitPullRequestAtom } = yield* setupWith;
      const statusAtom = git.gitStatusAtom({ projectId, threadId });
      registry.mount(statusAtom);
      yield* Effect.promise(() =>
        awaitResult(registry, statusAtom, (result) => AsyncResult.isSuccess(result)),
      );

      registry.mount(gitPushAtom);
      registry.set(gitPushAtom, { projectId, threadId });
      yield* Effect.promise(() =>
        awaitResult(
          registry,
          statusAtom,
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value._tag === "ok" &&
            result.value.value.upstream === `origin/${WORKTREE.branch}`,
        ),
      );
      expect(calls.push).toEqual([{ projectId, threadId }]);

      registry.mount(gitPullRequestAtom);
      registry.set(gitPullRequestAtom, { projectId, threadId, title: "Fix the login", body: "" });
      const opened = yield* Effect.promise(() =>
        awaitResult(registry, gitPullRequestAtom, (result) => AsyncResult.isSuccess(result)),
      );
      expect(AsyncResult.isSuccess(opened) && opened.value.url).toBe(
        "https://github.com/acme/app/pull/7",
      );
      expect(calls.pullRequest).toEqual([
        { projectId, threadId, title: "Fix the login", body: "" },
      ]);
    }),
  );
});
