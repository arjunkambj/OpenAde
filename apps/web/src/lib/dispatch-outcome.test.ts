import { describe, expect, it } from "vitest";
import { makeCommandId } from "@OpenAde/contracts/ids";
import type { CommandReceipt } from "@OpenAde/contracts/orchestration";

import { DISPATCH_UNREACHABLE, receiptError } from "./dispatch-outcome";

const receipt = (status: CommandReceipt["status"], reason?: string): CommandReceipt => ({
  commandId: makeCommandId(),
  status,
  lastSequence: 0,
  ...(reason === undefined ? {} : { reason }),
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
