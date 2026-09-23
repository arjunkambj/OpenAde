import { describe, expect, it } from "vitest";

import { makeThreadId } from "@OpenAde/contracts/ids";

import { threadCommandBase } from "./thread-actions";

describe("threadCommandBase", () => {
  it("addresses the thread it was given", () => {
    const threadId = makeThreadId();
    expect(threadCommandBase(threadId).threadId).toBe(threadId);
  });

  it("mints a fresh command id on every call", () => {
    const threadId = makeThreadId();
    const first = threadCommandBase(threadId);
    const second = threadCommandBase(threadId);
    expect(first.commandId).not.toBe(second.commandId);
  });

  it("stamps an ISO creation time", () => {
    const { createdAt } = threadCommandBase(makeThreadId());
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });
});
