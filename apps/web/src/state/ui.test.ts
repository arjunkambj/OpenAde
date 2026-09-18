import { describe, expect, it } from "vitest";

import { emptyComposerDraft, parseDockTabs, withComposerDraft, type ComposerDraft } from "./ui";

describe("parseDockTabs", () => {
  it("reads a thread-to-tab map back", () => {
    expect(parseDockTabs('{"0199c0de-0002-7000-8000-000000000001":"browser"}')).toEqual({
      "0199c0de-0002-7000-8000-000000000001": "browser",
    });
  });

  it("is empty when nothing was ever stored", () => {
    expect(parseDockTabs(null)).toEqual({});
    expect(parseDockTabs(undefined)).toEqual({});
  });

  it("survives storage written by something else", () => {
    expect(parseDockTabs("not json")).toEqual({});
    expect(parseDockTabs('["browser"]')).toEqual({});
    expect(parseDockTabs("null")).toEqual({});
  });

  it("drops entries that are not tab names", () => {
    expect(parseDockTabs('{"a":"changes","b":7,"c":null}')).toEqual({ a: "changes" });
  });
});

describe("withComposerDraft", () => {
  const file = { name: "shot.png" } as unknown as File;
  const draft = (over: Partial<ComposerDraft> = {}): ComposerDraft => ({
    ...emptyComposerDraft,
    ...over,
  });

  it("keeps each thread's draft under its own key", () => {
    // The regression: the draft was component state and the composer unmounts
    // on every thread switch, so leaving thread A to glance at thread B threw
    // A's unsent message and its staged attachments away.
    const one = withComposerDraft({}, "a", draft({ text: "half a message" }));
    const both = withComposerDraft(one, "b", draft({ text: "another" }));
    expect(both.a?.text).toBe("half a message");
    expect(both.b?.text).toBe("another");
  });

  it("remembers mentions and staged files, not just text", () => {
    const drafts = withComposerDraft({}, "a", draft({ mentions: ["src/main.ts"], files: [file] }));
    expect(drafts.a).toEqual({ text: "", mentions: ["src/main.ts"], files: [file] });
  });

  it("drops the key once a draft is empty again, so the map does not grow", () => {
    const drafts = withComposerDraft({}, "a", draft({ text: "typed" }));
    expect(withComposerDraft(drafts, "a", emptyComposerDraft)).toEqual({});
  });

  it("returns the same map when clearing a thread that never had one", () => {
    const drafts = withComposerDraft({}, "a", draft({ text: "typed" }));
    expect(withComposerDraft(drafts, "b", emptyComposerDraft)).toBe(drafts);
  });

  it("never mutates the map it was given", () => {
    const before = withComposerDraft({}, "a", draft({ text: "typed" }));
    const snapshot = { ...before };
    withComposerDraft(before, "a", draft({ text: "more" }));
    withComposerDraft(before, "a", emptyComposerDraft);
    expect(before).toEqual(snapshot);
  });
});
