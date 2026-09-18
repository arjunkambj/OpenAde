import { describe, expect, it } from "vitest";

import { projectRemovalWarning } from "./removal-copy";

describe("projectRemovalWarning", () => {
  it("reads as English with no threads under the project", () => {
    expect(projectRemovalWarning("proj", 0, "/tmp/proj")).toBe(
      "proj is removed from OpenAde. Nothing in /tmp/proj is touched.",
    );
  });

  it("names one thread in the singular", () => {
    expect(projectRemovalWarning("proj", 1, "/tmp/proj")).toBe(
      "proj and its one thread are removed from OpenAde, with that thread's transcript and turn checkpoints. Nothing in /tmp/proj is touched.",
    );
  });

  it("counts the threads it will delete", () => {
    // The reactor dispatches a `thread.delete` for every one of them, so the
    // number is the point of the sentence.
    expect(projectRemovalWarning("proj", 4, "/tmp/proj")).toContain("its 4 threads are removed");
  });

  it("always says the workspace is left alone", () => {
    for (const count of [0, 1, 9]) {
      expect(projectRemovalWarning("proj", count, "/tmp/proj")).toContain(
        "Nothing in /tmp/proj is touched.",
      );
    }
  });
});
