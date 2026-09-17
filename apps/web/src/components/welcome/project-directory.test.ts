/**
 * The first-run blocker, pinned. The field used to publish its value only on
 * blur, so a typed path left "Create project" disabled and the disabled button
 * could not be clicked to blur the field: a fresh install had no way in.
 *
 * The first case is that regression — one keystroke, and the button is live.
 */

import { describe, expect, it } from "vitest";

import {
  canCreateProject,
  directoryPicked,
  directoryProblem,
  directoryRejected,
  directoryTyped,
  emptyDirectory,
} from "./project-directory";

describe("welcome project directory", () => {
  it("a typed path enables Create with no commit step", () => {
    expect(canCreateProject(emptyDirectory, false)).toBe(false);
    // One keystroke at a time — every prefix of an absolute path is already a
    // value, and the moment it is non-empty and absolute the button is live.
    expect(canCreateProject(directoryTyped("/"), false)).toBe(true);
    expect(canCreateProject(directoryTyped("/Users/you/code/my-app"), false)).toBe(true);
    expect(directoryTyped("/Users/you/code/my-app").path).toBe("/Users/you/code/my-app");
  });

  it("the native picker's answer lands in the same state", () => {
    const picked = directoryPicked("/Users/you/code/my-app");
    expect(picked).toEqual(directoryTyped("/Users/you/code/my-app"));
    expect(canCreateProject(picked, false)).toBe(true);
    expect(directoryProblem(picked)).toBeNull();
  });

  it("a path the string itself rules out blocks Create and says why", () => {
    const tilde = directoryTyped("~/code/my-app");
    expect(canCreateProject(tilde, false)).toBe(false);
    expect(directoryProblem(tilde)).toBe("Use the full path — ~ is not expanded.");

    const relative = directoryTyped("code/my-app");
    expect(canCreateProject(relative, false)).toBe(false);
    expect(directoryProblem(relative)).toBe(
      "Enter an absolute path, starting at the root of the disk.",
    );
  });

  it("a server rejection shows its reason, keeps the text and allows a retry", () => {
    const typed = directoryTyped("/Users/you/code/missing");
    const refused = directoryRejected(typed, "workspace root does not exist");
    expect(refused.path).toBe("/Users/you/code/missing");
    expect(directoryProblem(refused)).toBe("workspace root does not exist");
    // A transport failure is a rejection too, so it must not latch the button off.
    expect(canCreateProject(refused, false)).toBe(true);
    // Editing the path clears the stale reason.
    expect(directoryProblem(directoryTyped("/Users/you/code/real"))).toBeNull();
  });

  it("a problem in the string outranks a stale server reason", () => {
    const refused = directoryRejected(directoryTyped("~/code/my-app"), "not a directory");
    expect(directoryProblem(refused)).toBe("Use the full path — ~ is not expanded.");
  });

  it("Create is off while a create is in flight", () => {
    expect(canCreateProject(directoryTyped("/Users/you/code/my-app"), true)).toBe(false);
  });
});
