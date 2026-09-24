import { describe, expect, it } from "vitest";

import { threadStatusMark } from "./thread-status";
import { AlertTriangle, Bell, ClipboardCheck, SpinnerOrbit, SpinnerWave } from "@honeyicons/react";

const NEEDS_YOU = { icon: Bell, label: "Needs you", tone: "text-permission" };

describe("threadStatusMark", () => {
  it("an open approval or question needs the user", () => {
    expect(
      threadStatusMark({ status: "waiting", awaitingInput: true, awaiting: "approval" }),
    ).toEqual(NEEDS_YOU);
    expect(
      threadStatusMark({ status: "waiting", awaitingInput: true, awaiting: "question" }),
    ).toEqual(NEEDS_YOU);
  });

  it("a finished plan reads as ready, not as an alarm", () => {
    expect(threadStatusMark({ status: "waiting", awaitingInput: true, awaiting: "plan" })).toEqual({
      icon: ClipboardCheck,
      label: "Plan ready",
      tone: "text-foreground",
    });
  });

  it("a thread waiting on the user looks waiting even while a turn runs", () => {
    // The server keeps `status: "running"` when one of two approvals resolves
    // mid-turn, with the second still open. The icon must follow the label,
    // not the status, or the row spins grey while it says "Needs you".
    expect(
      threadStatusMark({ status: "running", awaitingInput: true, awaiting: "approval" }),
    ).toEqual(NEEDS_YOU);
    expect(threadStatusMark({ status: "running", awaitingInput: true })).toEqual(NEEDS_YOU);
  });

  it("falls back to needs-you when `awaiting` is absent", () => {
    // A summary from before `awaiting` existed, or a waiting status with
    // nothing open: the louder mark is the safe guess.
    expect(threadStatusMark({ status: "idle", awaitingInput: true })).toEqual(NEEDS_YOU);
    expect(threadStatusMark({ status: "waiting", awaitingInput: false })).toEqual(NEEDS_YOU);
  });

  it("a running turn with no tool in flight is thinking", () => {
    const mark = threadStatusMark({ status: "running", awaitingInput: false });
    expect(mark?.label).toBe("Thinking");
    expect(mark?.icon).toBe(SpinnerOrbit);
    expect(mark?.tone).toBe("text-muted-foreground");
  });

  it("a running turn with a tool in flight is working", () => {
    const mark = threadStatusMark({ status: "running", awaitingInput: false, activity: "working" });
    expect(mark?.label).toBe("Working");
    expect(mark?.icon).toBe(SpinnerWave);
  });

  it("an error outranks nothing but is reported", () => {
    const mark = threadStatusMark({ status: "error", awaitingInput: false });
    expect(mark?.icon).toBe(AlertTriangle);
    expect(mark?.label).toBe("Error");
    expect(mark?.tone).toBe("text-destructive");
    // A thread that errored while an approval was pending still needs the user.
    expect(
      threadStatusMark({ status: "error", awaitingInput: true, awaiting: "approval" }),
    ).toEqual(NEEDS_YOU);
  });

  it("quiet threads report nothing", () => {
    expect(threadStatusMark({ status: "idle", awaitingInput: false })).toBeNull();
    expect(threadStatusMark({ status: "archived", awaitingInput: false })).toBeNull();
    expect(threadStatusMark({ status: "deleted", awaitingInput: false })).toBeNull();
  });
});
