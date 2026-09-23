import { describe, expect, it } from "vitest";

import { parseSessionRef } from "./sessionRef";

const SESSION = "194d63a1-7180-4e20-95d4-396321ca399c";

describe("parseSessionRef", () => {
  it("reads a full ref", () => {
    expect(
      parseSessionRef({
        sessionId: SESSION,
        cwd: "/work/repo",
        lastAssistantUuid: "3a3e5f56-8c4a-4e9c-a79f-f6c9c6d87f6c",
        totalCostUsd: 0.25,
      }),
    ).toEqual({
      sessionId: SESSION,
      cwd: "/work/repo",
      lastAssistantUuid: "3a3e5f56-8c4a-4e9c-a79f-f6c9c6d87f6c",
      totalCostUsd: 0.25,
    });
  });

  it("reads the minimal ref and ignores fields it does not know", () => {
    expect(parseSessionRef({ sessionId: SESSION, cwd: "/work/repo", other: 1 })).toEqual({
      sessionId: SESSION,
      cwd: "/work/repo",
    });
  });

  it("drops optional fields that are not what they say", () => {
    expect(
      parseSessionRef({ sessionId: SESSION, cwd: "/w", lastAssistantUuid: 7, totalCostUsd: -1 }),
    ).toEqual({ sessionId: SESSION, cwd: "/w" });
  });

  it.each([
    ["nothing", undefined],
    ["a string", SESSION],
    ["another connector's ref", { sessionId: SESSION, transcriptPath: "/t" }],
    ["an id the CLI would refuse", { sessionId: "not-a-uuid", cwd: "/w" }],
    ["an empty cwd", { sessionId: SESSION, cwd: "" }],
  ])("is undefined for %s", (_label, raw) => {
    expect(parseSessionRef(raw)).toBeUndefined();
  });
});
