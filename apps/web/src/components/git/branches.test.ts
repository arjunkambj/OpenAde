import type { GitBranch, GitBranchList } from "@OpenAde/contracts/git";
import { OpenAdeRpcError } from "@OpenAde/contracts/rpc";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  branchToCreate,
  branchWriteFailure,
  groupBranches,
  branchNameProblem,
  looksLikeBranchName,
  remoteShortName,
} from "./branches";

const local = (name: string, isCurrent = false): GitBranch => ({ name, kind: "local", isCurrent });
const remote = (name: string): GitBranch => ({ name, kind: "remote", isCurrent: false });

const LIST: GitBranchList = {
  isRepository: true,
  current: "openade/feature",
  defaultBranch: "main",
  remotes: ["origin", "team/eu"],
  branches: [
    local("main"),
    local("openade/feature", true),
    local("release"),
    remote("origin/main"),
    remote("origin/hotfix"),
    remote("team/eu/release"),
    remote("team/eu/audit"),
  ],
};

const names = (branches: ReadonlyArray<GitBranch>) => branches.map((branch) => branch.name);

describe("remoteShortName", () => {
  it("strips the remote, the longest matching one first", () => {
    expect(remoteShortName("origin/feature/x", LIST.remotes)).toBe("feature/x");
    expect(remoteShortName("team/eu/release", ["team", "team/eu"])).toBe("release");
    expect(remoteShortName("upstream/main", LIST.remotes)).toBe("upstream/main");
  });
});

describe("groupBranches", () => {
  it("lists the current branch first and hides a remote branch whose local twin exists", () => {
    const groups = groupBranches(LIST, "");
    expect(names(groups.local)).toEqual(["openade/feature", "main", "release"]);
    // origin/main and team/eu/release have local twins; the others do not.
    expect(names(groups.remote)).toEqual(["origin/hotfix", "team/eu/audit"]);
  });

  it("filters both groups by a case-insensitive substring", () => {
    const groups = groupBranches(LIST, "  FEAT ");
    expect(names(groups.local)).toEqual(["openade/feature"]);
    expect(groups.remote).toEqual([]);
    expect(names(groupBranches(LIST, "hot").remote)).toEqual(["origin/hotfix"]);
    expect(names(groupBranches(LIST, "origin").remote)).toEqual(["origin/hotfix"]);
  });

  it("answers empty groups for a repository with no branches", () => {
    const empty: GitBranchList = { ...LIST, current: null, branches: [] };
    expect(groupBranches(empty, "x")).toEqual({ local: [], remote: [] });
  });
});

describe("branchNameProblem", () => {
  it("says nothing for a blank query or an acceptable name", () => {
    for (const name of ["", "fix", "openade/fix-login", "me/v1.2"]) {
      expect(branchNameProblem(name), name).toBeNull();
    }
  });

  it("names the rule a refused name breaks", () => {
    expect(branchNameProblem("review/new branch")).toBe("A branch name can't hold spaces.");
    expect(branchNameProblem("a..b")).toBe("A branch name can't hold “..” or “@{”.");
    expect(branchNameProblem("feature/")).toBe(
      "A branch name can't start or end with “/” or hold “//”.",
    );
    expect(branchNameProblem("-x")).toBe("A branch name can't start with “-”.");
    expect(branchNameProblem("a:b")).toBe("A branch name can't hold ~ ^ : ? * [ or \\.");
    expect(branchNameProblem("x.lock")).toBe("A branch name can't end with “.” or “.lock”.");
    expect(branchNameProblem("a/.hidden")).toBe("No part of a branch name can start with “.”.");
    expect(branchNameProblem("@")).toBe("A branch can't be named “@”.");
  });
});

describe("looksLikeBranchName", () => {
  it("accepts ordinary names, prefixes included", () => {
    for (const name of ["fix", "openade/fix-login", "me/v1.2", "a_b"]) {
      expect(looksLikeBranchName(name)).toBe(true);
    }
  });

  it("refuses what git's ref-format rules refuse", () => {
    for (const name of [
      "",
      "@",
      "-x",
      "/x",
      "x/",
      "x.",
      "x.lock",
      "a//b",
      "a..b",
      "a@{b",
      "has space",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a\tb",
      "a/.hidden",
      ".hidden",
    ]) {
      expect(looksLikeBranchName(name), name).toBe(false);
    }
  });
});

describe("branchToCreate", () => {
  it("offers a new valid name, trimmed", () => {
    expect(branchToCreate(LIST, "  openade/new-idea ")).toBe("openade/new-idea");
  });

  it("is not offered for a blank query or a name git would refuse", () => {
    expect(branchToCreate(LIST, "   ")).toBeNull();
    expect(branchToCreate(LIST, "has space")).toBeNull();
    expect(branchToCreate(LIST, "-x")).toBeNull();
  });

  it("is not offered for a name that is already a branch, local or remote", () => {
    expect(branchToCreate(LIST, "main")).toBeNull();
    expect(branchToCreate(LIST, "origin/hotfix")).toBeNull();
    // A remote's own name is already in the list, as a branch to switch to.
    expect(branchToCreate(LIST, "hotfix")).toBeNull();
    expect(branchToCreate(LIST, "audit")).toBeNull();
  });
});

describe("branchWriteFailure", () => {
  it("is null on success and the server's message on a refusal", () => {
    expect(branchWriteFailure(Exit.succeed(LIST))).toBeNull();
    const dirty = new OpenAdeRpcError({
      code: "conflict",
      message: "The working tree has uncommitted changes to tracked files.",
    });
    expect(branchWriteFailure(Exit.fail(dirty))).toBe(
      "The working tree has uncommitted changes to tracked files.",
    );
  });

  it("falls back to a plain line when the failure carries no message", () => {
    expect(branchWriteFailure(Exit.die("boom"))).toBe("The branch could not be switched.");
  });
});
