import { describe, expect, it } from "vitest";

import {
  containsComposerToken,
  detectComposerTrigger,
  replaceComposerTrigger,
  retainComposerReferences,
} from "./composerTrigger";

const at = (text: string) => detectComposerTrigger(text, text.length);

describe("detectComposerTrigger", () => {
  it("opens a slash trigger at the start of the text", () => {
    expect(detectComposerTrigger("/mod", 4)).toEqual({
      kind: "slash",
      from: 0,
      to: 4,
      query: "mod",
    });
  });

  it("opens a slash trigger after whitespace, with an empty query", () => {
    expect(at("run /")).toEqual({ kind: "slash", from: 4, to: 5, query: "" });
    expect(at("/")).toMatchObject({ kind: "slash", query: "" });
  });

  it("opens a file trigger on # at the start of the text", () => {
    expect(at("#comp")).toEqual({ kind: "file", from: 0, to: 5, query: "comp" });
  });

  it("opens a file trigger on # after a space or a newline", () => {
    expect(at("look at #sr")).toEqual({ kind: "file", from: 8, to: 11, query: "sr" });
    expect(at("first line\n#src/app")).toEqual({
      kind: "file",
      from: 11,
      to: 19,
      query: "src/app",
    });
  });

  it("opens on an issue number, which then lists no files", () => {
    expect(at("fixes #12")).toMatchObject({ kind: "file", query: "12" });
  });

  it("keeps # closed until a query starts", () => {
    expect(at("#")).toBeNull();
    expect(at("see #")).toBeNull();
  });

  it("never opens on a markdown heading", () => {
    expect(at("# heading")).toBeNull();
    expect(at("# ")).toBeNull();
    expect(at("## heading")).toBeNull();
    expect(at("##")).toBeNull();
    expect(at("###")).toBeNull();
    expect(at("intro\n### ")).toBeNull();
  });

  it("does not open # mid-word or inside a URL", () => {
    expect(at("a#b")).toBeNull();
    expect(at("https://x.dev/#frag")).toBeNull();
    expect(at("see https://x.dev/#frag")).toBeNull();
  });

  it("closes a file trigger once a space follows it", () => {
    expect(at("#src ")).toBeNull();
    expect(at("#src now")).toBeNull();
  });

  it("no longer opens on @", () => {
    expect(at("@foo")).toBeNull();
    expect(at("look at @sr")).toBeNull();
    expect(at("@")).toBeNull();
  });

  it("does not open inside an email or mid-token", () => {
    const email = "mail me@ex";
    expect(detectComposerTrigger(email, email.length)).toBeNull();
    const mid = "foo/bar";
    expect(detectComposerTrigger(mid, mid.length)).toBeNull();
  });

  it("closes once whitespace follows the trigger", () => {
    const text = "/model now";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("ignores a trigger beyond the caret", () => {
    expect(detectComposerTrigger("#abc tail", 4)).toMatchObject({ kind: "file", query: "abc" });
    expect(detectComposerTrigger("/abc tail", 4)).toMatchObject({ kind: "slash", query: "abc" });
  });
});

describe("replaceComposerTrigger", () => {
  it("splices the replacement and lands the caret after it", () => {
    const text = "see #sr please";
    const trigger = detectComposerTrigger(text, 7)!;
    const next = replaceComposerTrigger(text, trigger, "#src/app.ts ");
    expect(next.text).toBe("see #src/app.ts  please");
    expect(next.cursor).toBe("see #src/app.ts ".length);
  });
});

describe("retainComposerReferences", () => {
  it("keeps references whose token is still a whole token", () => {
    const refs = ["src/app.ts", "src/other.ts"];
    const text = "check #src/app.ts done";
    expect(retainComposerReferences(refs, text, (r) => `#${r}`)).toEqual(["src/app.ts"]);
  });

  it("returns the same array when nothing dropped", () => {
    const refs = ["src/app.ts"];
    const text = "check #src/app.ts";
    const next = retainComposerReferences(refs, text, (r) => `#${r}`);
    expect(next).toBe(refs);
  });

  it("requires token boundaries", () => {
    expect(containsComposerToken("@ab extra", "@ab")).toBe(true);
    expect(containsComposerToken("@abc", "@ab")).toBe(false);
    expect(containsComposerToken("x@ab", "@ab")).toBe(false);
  });
});
