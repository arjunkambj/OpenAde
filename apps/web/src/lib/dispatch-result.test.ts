import { makeCommandId } from "@OpenAde/contracts/ids";
import type { CommandReceipt } from "@OpenAde/contracts/orchestration";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import { isAccepted, rejectionMessage } from "./dispatch-result";

const receipt = (over: Partial<CommandReceipt> = {}): CommandReceipt => ({
  commandId: makeCommandId(),
  status: "accepted",
  lastSequence: 0,
  ...over,
});

describe("dispatch-result", () => {
  it("accepts only a successful exit carrying an accepted receipt", () => {
    expect(isAccepted(Exit.succeed(receipt()))).toBe(true);
    expect(isAccepted(Exit.succeed(receipt({ status: "rejected" })))).toBe(false);
    expect(isAccepted(Exit.fail(new Error("socket closed")))).toBe(false);
  });

  it("prefers the server's own rejection reason", () => {
    const exit = Exit.succeed(receipt({ status: "rejected", reason: "workspace root missing" }));
    expect(rejectionMessage(exit, "Thread was rejected")).toBe("workspace root missing");
  });

  it("falls back when the server rejected without a reason", () => {
    const exit = Exit.succeed(receipt({ status: "rejected" }));
    expect(rejectionMessage(exit, "Thread was rejected")).toBe("Thread was rejected");
  });

  it("names the transport when the command never got an answer", () => {
    expect(rejectionMessage(Exit.fail(new Error("socket closed")), "Thread was rejected")).toBe(
      "Could not reach the server",
    );
  });
});
