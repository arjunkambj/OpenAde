import { describe, expect, it } from "vitest";

import { onComposerFocusRequest, requestComposerFocus, takeComposerFocus } from "./composer-focus";

describe("composer focus requests", () => {
  it("is taken once, by the thread it names", () => {
    requestComposerFocus("t1");
    expect(takeComposerFocus("t2")).toBe(false);
    expect(takeComposerFocus("t1")).toBe(true);
    expect(takeComposerFocus("t1")).toBe(false);
  });

  it("is replaced by a newer request", () => {
    requestComposerFocus("t1");
    requestComposerFocus("t2");
    expect(takeComposerFocus("t1")).toBe(false);
    expect(takeComposerFocus("t2")).toBe(true);
  });

  it("reaches a composer that is already mounted", () => {
    // A blank thread handed back may already be on screen: its composer
    // listens, and takes the request the moment it is made.
    const taken: Array<string> = [];
    const stop = onComposerFocusRequest(() => {
      if (takeComposerFocus("t3")) {
        taken.push("t3");
      }
    });
    requestComposerFocus("t4");
    requestComposerFocus("t3");
    stop();
    requestComposerFocus("t3");
    expect(taken).toEqual(["t3"]);
    expect(takeComposerFocus("t3")).toBe(true);
  });
});
