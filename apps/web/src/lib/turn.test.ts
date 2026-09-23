import fixture from "@OpenAde/contracts/fixtures/thread-detail-snapshot.json";
import { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { turnInFlight } from "./turn";

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
