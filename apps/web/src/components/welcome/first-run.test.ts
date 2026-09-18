import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import { shouldOfferFirstRun } from "./first-run";

describe("shouldOfferFirstRun", () => {
  it("fires for an answered, empty project list", () => {
    // The regression: the guard also required `!projects.waiting`, and an atom
    // over a stream that never ends is `waiting` forever — so the redirect
    // could not fire and a fresh install had no way into the welcome flow.
    expect(shouldOfferFirstRun(AsyncResult.success([], { waiting: true }))).toBe(true);
    expect(shouldOfferFirstRun(AsyncResult.success([]))).toBe(true);
  });

  it("waits for the list to answer, so a cold load does not bounce", () => {
    expect(shouldOfferFirstRun(AsyncResult.initial(true))).toBe(false);
    expect(shouldOfferFirstRun(AsyncResult.initial())).toBe(false);
  });

  it("stays put once there is a project", () => {
    expect(shouldOfferFirstRun(AsyncResult.success([{ projectId: "p1" }]))).toBe(false);
  });

  it("stays put when the list could not be read", () => {
    expect(shouldOfferFirstRun(AsyncResult.failure(Cause.fail("nope")))).toBe(false);
  });
});
