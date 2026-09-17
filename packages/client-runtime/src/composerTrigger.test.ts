import { describe, expect, it } from "vitest";

import {
  containsComposerToken,
  detectComposerTrigger,
  replaceComposerTrigger,
  retainComposerReferences,
} from "./composerTrigger";

describe("detectComposerTrigger", () => {
  it("opens a slash trigger at the start of the text", () => {
    expect(detectComposerTrigger("/mod", 4)).toEqual({
      kind: "slash",
      from: 0,
      to: 4,
      query: "mod",
    });
  });

  it("opens an at trigger after whitespace", () => {
    const text = "look at @sr";
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "at",
      from: 8,
      query: "sr",
    });
  });

  it("does not open inside an email or mid-token", () => {
    const email = "mail me@ex";
    expect(detectComposerTrigger(email, email.length)).toBeNull();
    const mid = "foo/bar";
    expect(detectComposerTrigger(mid, mid.length)).toBeNull();
  });

  it("closes once whitespace follows the trigger", () => {
    const text = "@src/app now";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("reports the empty query right after the char", () => {
    expect(detectComposerTrigger("@", 1)).toMatchObject({ kind: "at", query: "" });
  });

  it("ignores a trigger beyond the caret", () => {
    const text = "@abc tail";
    expect(detectComposerTrigger(text, 4)).toMatchObject({ query: "abc" });
  });
});

describe("replaceComposerTrigger", () => {
  it("splices the replacement and lands the caret after it", () => {
    const text = "see @sr please";
    const trigger = detectComposerTrigger(text, 7)!;
    const next = replaceComposerTrigger(text, trigger, "@src/app.ts ");
    expect(next.text).toBe("see @src/app.ts  please");
    expect(next.cursor).toBe("see @src/app.ts ".length);
  });
});

describe("retainComposerReferences", () => {
  it("keeps references whose token is still a whole token", () => {
    const refs = ["src/app.ts", "src/other.ts"];
    const text = "check @src/app.ts done";
    expect(retainComposerReferences(refs, text, (r) => `@${r}`)).toEqual(["src/app.ts"]);
  });

  it("returns the same array when nothing dropped", () => {
    const refs = ["src/app.ts"];
    const text = "check @src/app.ts";
    const next = retainComposerReferences(refs, text, (r) => `@${r}`);
    expect(next).toBe(refs);
  });

  it("requires token boundaries", () => {
    expect(containsComposerToken("@ab extra", "@ab")).toBe(true);
    expect(containsComposerToken("@abc", "@ab")).toBe(false);
    expect(containsComposerToken("x@ab", "@ab")).toBe(false);
  });
});
