import { makeCommandId } from "@poseidon/contracts/ids";
import type { CommandReceipt } from "@poseidon/contracts/orchestration";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  DISPATCH_UNREACHABLE,
  isAccepted,
  receiptError,
  rejectionMessage,
} from "./dispatch-outcome";

const receipt = (status: CommandReceipt["status"], reason?: string): CommandReceipt => ({
  commandId: makeCommandId(),
  status,
  lastSequence: 0,
  ...(reason === undefined ? {} : { reason }),
});

/** The `promiseExit` half reads a whole receipt, so it builds one by overrides. */
const exitReceipt = (over: Partial<CommandReceipt> = {}): CommandReceipt => ({
  commandId: makeCommandId(),
  status: "accepted",
  lastSequence: 0,
  ...over,
});

describe("receiptError", () => {
  it("returns null for an accepted receipt", () => {
    expect(receiptError(receipt("accepted"), "fallback")).toBeNull();
  });

  it("returns the server's reason when it gave one", () => {
    expect(receiptError(receipt("rejected", "no such turn"), "fallback")).toBe("no such turn");
  });

  it("falls back when the rejection carries no reason", () => {
    expect(receiptError(receipt("rejected"), "fallback")).toBe("fallback");
  });
});

describe("DISPATCH_UNREACHABLE", () => {
  it("is a non-empty line the cards can render", () => {
    expect(DISPATCH_UNREACHABLE.length).toBeGreaterThan(0);
  });
});

describe("exit mode", () => {
  it("accepts only a successful exit carrying an accepted receipt", () => {
    expect(isAccepted(Exit.succeed(exitReceipt()))).toBe(true);
    expect(isAccepted(Exit.succeed(exitReceipt({ status: "rejected" })))).toBe(false);
    expect(isAccepted(Exit.fail(new Error("socket closed")))).toBe(false);
  });

  it("prefers the server's own rejection reason", () => {
    const exit = Exit.succeed(
      exitReceipt({ status: "rejected", reason: "workspace root missing" }),
    );
    expect(rejectionMessage(exit, "Thread was rejected")).toBe("workspace root missing");
  });

  it("falls back when the server rejected without a reason", () => {
    const exit = Exit.succeed(exitReceipt({ status: "rejected" }));
    expect(rejectionMessage(exit, "Thread was rejected")).toBe("Thread was rejected");
  });

  it("names the transport when the command never got an answer", () => {
    expect(rejectionMessage(Exit.fail(new Error("socket closed")), "Thread was rejected")).toBe(
      "Could not reach the server",
    );
  });
});
