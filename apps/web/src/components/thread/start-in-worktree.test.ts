import type { WorktreeSetupProgress } from "@OpenAde/client-runtime/gitCommands";
import type { ThreadWorktree } from "@OpenAde/contracts/git";
import { describe, expect, it } from "vitest";

import {
  finishInWorktree,
  setupFailureReason,
  startInWorktree,
  worktreeName,
  type WorktreeStartSteps,
} from "./start-in-worktree";

const WORKTREE: ThreadWorktree = {
  path: "/home/me/.openade/worktrees/app/fix-login",
  branch: "openade/fix-login",
  baseBranch: "main",
};

const run = (over: Partial<WorktreeSetupProgress> = {}): WorktreeSetupProgress => ({
  output: "",
  exit: { code: 0 },
  skipped: false,
  ...over,
});

/** Steps that log each call in order, answering from the overrides. */
const recorder = (over: Partial<WorktreeStartSteps> = {}) => {
  const log: Array<string> = [];
  const steps: WorktreeStartSteps = {
    createWorktree: async () => {
      log.push("create");
      return WORKTREE;
    },
    runSetup: async (worktree) => {
      log.push(`setup ${worktree.path}`);
      return run({ output: "installed\n" });
    },
    createThread: async (worktree) => {
      log.push(`thread ${worktree.branch}`);
      return true;
    },
    send: () => {
      log.push("send");
    },
    onStep: (step) => {
      log.push(`step ${step.step}`);
    },
    ...over,
  };
  return { log, steps };
};

describe("startInWorktree", () => {
  it("creates, runs setup, creates the thread in the worktree, then sends", async () => {
    const { log, steps } = recorder();
    await expect(startInWorktree(steps)).resolves.toEqual({ _tag: "started", worktree: WORKTREE });
    expect(log).toEqual([
      "step creating",
      "create",
      "step setup",
      `setup ${WORKTREE.path}`,
      "step starting",
      "thread openade/fix-login",
      "send",
    ]);
  });

  it("starts when the project has no setup script", async () => {
    const { log, steps } = recorder({
      runSetup: async () => run({ exit: null, skipped: true }),
    });
    await expect(startInWorktree(steps)).resolves.toEqual({ _tag: "started", worktree: WORKTREE });
    expect(log.slice(-2)).toEqual(["thread openade/fix-login", "send"]);
  });

  it("stops before the thread exists when setup exits non-zero, with its output", async () => {
    const { log, steps } = recorder({
      runSetup: async () => run({ output: "npm ERR! missing script\n", exit: { code: 3 } }),
    });
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "setup-failed",
      worktree: WORKTREE,
      reason: "Setup script exited 3",
      output: "npm ERR! missing script\n",
    });
    expect(log.some((entry) => entry.startsWith("thread"))).toBe(false);
    expect(log).not.toContain("send");
  });

  it("stops on a script that was killed", async () => {
    const { steps } = recorder({
      runSetup: async () => run({ output: "waiting…\n", exit: { code: null, signal: "SIGTERM" } }),
    });
    const outcome = await startInWorktree(steps);
    expect(outcome._tag === "setup-failed" && outcome.reason).toBe(
      "Setup script was killed (SIGTERM)",
    );
  });

  it("stops when the setup stream itself fails, keeping what it printed", async () => {
    const { log, steps } = recorder({
      runSetup: () => Promise.reject({ message: "Setup script stopped", output: "step 1\n" }),
    });
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "setup-failed",
      worktree: WORKTREE,
      reason: "Setup script stopped",
      output: "step 1\n",
    });
    expect(log).not.toContain("send");
  });

  it("'start anyway' creates the thread and sends after a failed setup", async () => {
    const { log, steps } = recorder({ runSetup: async () => run({ exit: { code: 1 } }) });
    const failed = await startInWorktree(steps);
    expect(failed._tag).toBe("setup-failed");
    log.length = 0;
    await expect(finishInWorktree(steps, WORKTREE)).resolves.toEqual({
      _tag: "started",
      worktree: WORKTREE,
    });
    expect(log).toEqual(["step starting", "thread openade/fix-login", "send"]);
  });

  it("reports the server's message when the worktree cannot be created, and creates nothing", async () => {
    const { log, steps } = recorder({
      createWorktree: () =>
        Promise.reject({
          _tag: "OpenAdeRpcError",
          code: "invalid",
          message: "The project folder is not a git repository.",
        }),
    });
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "not-created",
      message: "The project folder is not a git repository.",
    });
    expect(log).toEqual(["step creating"]);
  });

  it("does not send when the thread is rejected, and keeps the worktree in the outcome", async () => {
    const { log, steps } = recorder({ createThread: async () => false });
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "thread-rejected",
      worktree: WORKTREE,
    });
    expect(log).not.toContain("send");
  });
});

describe("leaving the start screen mid-sequence", () => {
  /** The recorder, with the screen left once `leaveAt` is logged. */
  const leaving = (leaveAt: string, over: Partial<WorktreeStartSteps> = {}) => {
    const recorded = recorder({
      abandoned: () => recorded.log.includes(leaveAt),
      discard: async (worktree) => {
        recorded.log.push(`discard ${worktree.path}`);
      },
      ...over,
    });
    return recorded;
  };

  it("discards the worktree when the screen is left while it is created", async () => {
    const { log, steps } = leaving("create");
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "abandoned",
      worktree: WORKTREE,
      threadCreated: false,
    });
    expect(log).toEqual(["step creating", "create", `discard ${WORKTREE.path}`]);
  });

  it("discards the worktree when the screen is left during setup, whatever the script did", async () => {
    for (const runSetup of [
      async () => run({ output: "installed\n" }),
      async () => run({ exit: { code: 1 } }),
      () => Promise.reject({ message: "Setup script stopped", output: "" }),
    ]) {
      const { log, steps } = leaving(`setup ${WORKTREE.path}`, {
        runSetup: async (worktree) => {
          log.push(`setup ${worktree.path}`);
          return runSetup();
        },
      });
      const outcome = await startInWorktree(steps);
      expect(outcome).toEqual({ _tag: "abandoned", worktree: WORKTREE, threadCreated: false });
      expect(log.at(-1)).toBe(`discard ${WORKTREE.path}`);
      expect(log.some((entry) => entry.startsWith("thread"))).toBe(false);
    }
  });

  it("keeps a thread created after the screen was left, but does not send or move the user", async () => {
    const { log, steps } = leaving("thread openade/fix-login");
    await expect(startInWorktree(steps)).resolves.toEqual({
      _tag: "abandoned",
      worktree: WORKTREE,
      threadCreated: true,
    });
    expect(log).not.toContain("send");
    expect(log.some((entry) => entry.startsWith("discard"))).toBe(false);
  });

  it("discards the worktree when the thread was rejected after the screen was left", async () => {
    const { log, steps } = leaving("thread openade/fix-login", {
      createThread: async (worktree) => {
        log.push(`thread ${worktree.branch}`);
        return false;
      },
    });
    const outcome = await startInWorktree(steps);
    expect(outcome).toEqual({ _tag: "abandoned", worktree: WORKTREE, threadCreated: false });
    expect(log.at(-1)).toBe(`discard ${WORKTREE.path}`);
  });
});

describe("worktreeName", () => {
  it("names the worktree from the message's first non-blank line", () => {
    expect(worktreeName("\n  Fix the login redirect  \nand the tests")).toBe(
      "Fix the login redirect",
    );
  });

  it("falls back when there is no text, only attachments", () => {
    expect(worktreeName("   \n ")).toBe("thread");
  });
});

describe("setupFailureReason", () => {
  it("says when a script ended with no exit status", () => {
    expect(setupFailureReason(run({ exit: null }))).toBe(
      "Setup script ended without an exit status",
    );
  });
});
