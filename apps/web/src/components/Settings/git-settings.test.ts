import { describe, expect, it } from "vitest";

import { prefixProblem, prefixToSave, withSetupScript } from "./git-settings";

describe("prefixProblem", () => {
  it("accepts the default, a personal prefix and an empty one", () => {
    expect(prefixProblem("poseidon/")).toBeNull();
    expect(prefixProblem("me/fix-")).toBeNull();
    expect(prefixProblem("")).toBeNull();
  });

  it("names what git would refuse", () => {
    expect(prefixProblem("-x/")).toMatch(/start with “-”/);
    expect(prefixProblem("/x")).toMatch(/“\/”/);
    expect(prefixProblem("a//b")).toMatch(/“\/\/”/);
    expect(prefixProblem("has space/")).toMatch(/spaces/);
    expect(prefixProblem("bad..prefix/")).toMatch(/“\.\.”/);
    expect(prefixProblem("a@{b")).toMatch(/“@\{”/);
    expect(prefixProblem("what?")).toMatch(/~ \^ :/);
    expect(prefixProblem("back\\slash")).toMatch(/~ \^ :/);
    expect(prefixProblem("bell\u0007/")).toMatch(/~ \^ :/);
  });
});

describe("prefixToSave", () => {
  it("trims the draft", () => {
    expect(prefixToSave("poseidon/", "  me/ ")).toBe("me/");
  });

  it("saves nothing when the trimmed draft is what is saved", () => {
    expect(prefixToSave("poseidon/", "poseidon/ ")).toBeNull();
  });

  it("saves an emptied prefix", () => {
    expect(prefixToSave("poseidon/", "  ")).toBe("");
  });
});

describe("withSetupScript", () => {
  const saved = {
    p1: { setupScript: "pnpm install" },
    p2: { setupScript: "cp ../.env ." },
  };

  it("edits one project and keeps the others", () => {
    expect(withSetupScript(saved, "p1", "pnpm install\npnpm build\n")).toEqual({
      p1: { setupScript: "pnpm install\npnpm build" },
      p2: { setupScript: "cp ../.env ." },
    });
  });

  it("adds a project that had no settings", () => {
    expect(withSetupScript(saved, "p3", "make")).toEqual({ ...saved, p3: { setupScript: "make" } });
  });

  it("removes the key for a blank script, and the project with it", () => {
    expect(withSetupScript(saved, "p1", "   \n")).toEqual({ p2: { setupScript: "cp ../.env ." } });
  });

  it("saves nothing when the script is unchanged", () => {
    expect(withSetupScript(saved, "p1", "pnpm install\n")).toBeNull();
    expect(withSetupScript(saved, "p3", "  ")).toBeNull();
  });

  it("does not change the record it was given", () => {
    const before = structuredClone(saved);
    withSetupScript(saved, "p1", "");
    expect(saved).toEqual(before);
  });
});
