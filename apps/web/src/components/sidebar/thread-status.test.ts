import { describe, expect, it } from "vitest";

import { threadStatusMark } from "./thread-status";
import { Close, Spinner } from "@honeyicons/react";

describe("threadStatusMark", () => {
  it("a thread waiting on the user looks waiting even while a turn runs", () => {
    // The server keeps `status: "running"` when one of two approvals resolves
    // mid-turn, with `awaitingInput` still true. The icon must follow the
    // label, not the status, or the row spins grey while it says "Waiting".
    const mark = threadStatusMark({ status: "running", awaitingInput: true });
    expect(mark).toEqual({
      icon: Close,
      label: "Waiting for you",
      tone: "text-permission",
    });
  });

  it("a plain running turn shows the spinner", () => {
    const mark = threadStatusMark({ status: "running", awaitingInput: false });
    expect(mark?.label).toBe("Running");
    expect(mark?.icon).toBe(Spinner);
  });

  it("waiting without a pending item is still waiting", () => {
    expect(threadStatusMark({ status: "waiting", awaitingInput: false })?.label).toBe(
      "Waiting for you",
    );
  });

  it("an error outranks nothing but is reported", () => {
    const mark = threadStatusMark({ status: "error", awaitingInput: false });
    expect(mark?.icon).toBe(Close);
    expect(mark?.tone).toBe("text-destructive");
    // A thread that errored while an approval was pending still needs the user.
    expect(threadStatusMark({ status: "error", awaitingInput: true })?.label).toBe(
      "Waiting for you",
    );
  });

  it("quiet threads report nothing", () => {
    expect(threadStatusMark({ status: "idle", awaitingInput: false })).toBeNull();
    expect(threadStatusMark({ status: "archived", awaitingInput: false })).toBeNull();
    expect(threadStatusMark({ status: "deleted", awaitingInput: false })).toBeNull();
  });
});
