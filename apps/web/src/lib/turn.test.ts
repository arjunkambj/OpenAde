import localFixture from "@OpenAde/contracts/fixtures/read-models/thread-summary.json";
import worktreeFixture from "@OpenAde/contracts/fixtures/read-models/thread-summary.worktree.json";
import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import type { ProjectId } from "@OpenAde/contracts/ids";
import { ThreadDetailSnapshot, ThreadSummary } from "@OpenAde/contracts/orchestration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { projectFolderTurnRunning, turnInFlight } from "./turn";

const snapshot = (over: Record<string, unknown>): ThreadDetailSnapshot =>
  Schema.decodeUnknownSync(ThreadDetailSnapshot)({ ...fixture, ...over });

const turnId = "0199c0de-0004-7000-8000-000000000001";

describe("turnInFlight", () => {
  it("is false on an idle thread with no turn", () => {
    expect(turnInFlight(snapshot({ status: "idle", currentTurnId: null }))).toBe(false);
  });

  it("is true once a turn has started", () => {
    expect(turnInFlight(snapshot({ status: "running", currentTurnId: turnId }))).toBe(true);
  });

  // A turn that completes with messages queued moves the status to running
  // before the server's drain requests the next turn and names its id: that
  // window has to count as in flight, or a send there goes out unqueued.
  it("is true while the queue drains, when the id is still null", () => {
    expect(turnInFlight(snapshot({ status: "running", currentTurnId: null }))).toBe(true);
  });

  it("is true while a turn is waiting on the user", () => {
    expect(turnInFlight(snapshot({ status: "waiting", currentTurnId: turnId }))).toBe(true);
  });
});

describe("projectFolderTurnRunning", () => {
  const local = Schema.decodeUnknownSync(ThreadSummary)(localFixture);
  const inWorktree = Schema.decodeUnknownSync(ThreadSummary)(worktreeFixture);
  const projectId = local.projectId;
  const otherProject = "0199c0de-0001-7000-8000-000000000002" as ProjectId;

  it("is true while a local thread of the project runs a turn", () => {
    expect(projectFolderTurnRunning([{ ...local, status: "running" }], projectId)).toBe(true);
  });

  it("is false for a thread that is idle or only waiting", () => {
    expect(projectFolderTurnRunning([{ ...local, status: "idle" }], projectId)).toBe(false);
    expect(projectFolderTurnRunning([{ ...local, status: "waiting" }], projectId)).toBe(false);
  });

  it("leaves out a thread in its own worktree, and another project's", () => {
    expect(projectFolderTurnRunning([{ ...inWorktree, status: "running" }], projectId)).toBe(false);
    expect(projectFolderTurnRunning([{ ...local, status: "running" }], otherProject)).toBe(false);
  });
});
