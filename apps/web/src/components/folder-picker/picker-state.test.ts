/**
 * The folder picker's rules, without a DOM: where it opens, what the field
 * shows, where the cursor can go, which children a half-typed path means, and
 * what each key does on either side of the dialog.
 */

import { describe, expect, it } from "vitest";
import type { FsListing } from "@OpenAde/contracts/rpc";

import {
  breadcrumbFor,
  completionsFor,
  cursorOn,
  fieldValue,
  highlighted,
  initialLocation,
  movedCursor,
  movedTo,
  pickerKeyAction,
  splitTypedPath,
  typed,
} from "./picker-state";

const listing = (path: string, names: ReadonlyArray<string>): FsListing => ({
  path,
  parent: "/Users",
  entries: names.map((name) => ({ name, path: `${path}/${name}`, isGitRepo: false })),
  truncated: false,
});

const code = listing("/Users/dev/code", ["compose", "converse", "notes"]);

describe("where the picker opens", () => {
  it("browses an absolute path the field already had", () => {
    expect(initialLocation("  /Users/dev/code  ")).toEqual({
      path: "/Users/dev/code",
      draft: null,
      cursor: 0,
    });
  });

  it("falls back to the server's home for anything it cannot resolve", () => {
    for (const seed of ["", "   ", "code/my-app", "~/code"]) {
      expect(initialLocation(seed).path).toBeNull();
    }
  });

  // The dialog seeds itself with this on its first render and is mounted only
  // while it is open, so what a re-open shows is this function of the field —
  // never the directory the previous visit wandered off to.
  it("owes nothing to wherever the last visit ended up", () => {
    const wandered = movedCursor(typed(movedTo("/Users/dev/code"), "conv"), 2, code.entries.length);
    expect(wandered).toEqual({ path: "/Users/dev/code", draft: "conv", cursor: 2 });

    expect(initialLocation("/Volumes/work")).toEqual({
      path: "/Volumes/work",
      draft: null,
      cursor: 0,
    });
    expect(initialLocation("")).toEqual({ path: null, draft: null, cursor: 0 });
  });
});

describe("the path field", () => {
  it("shows the directory the server answered with until something is typed", () => {
    expect(fieldValue(movedTo("/Users/dev/code"), code)).toBe("/Users/dev/code");
  });

  it("shows an empty field as empty, rather than snapping back to the directory", () => {
    const cleared = typed(movedTo("/Users/dev/code"), "");
    expect(fieldValue(cleared, code)).toBe("");
  });

  it("keeps the directory that was asked for while its listing is still coming", () => {
    expect(fieldValue(movedTo("/Users/dev/code"), null)).toBe("/Users/dev/code");
  });

  it("shows nothing when nothing was asked for and nothing has answered", () => {
    expect(fieldValue(initialLocation(""), null)).toBe("");
  });

  it("puts the cursor back at the top on every keystroke", () => {
    const moved = movedCursor(movedTo("/Users/dev/code"), 2, code.entries.length);
    expect(typed(moved, "/Users/dev/c").cursor).toBe(0);
  });
});

describe("the cursor", () => {
  it("moves within the listing and stops at both ends", () => {
    const start = movedTo("/Users/dev/code");
    expect(movedCursor(start, -1, 3).cursor).toBe(0);
    expect(movedCursor(start, 1, 3).cursor).toBe(1);
    expect(movedCursor(movedCursor(start, 1, 3), 5, 3).cursor).toBe(2);
  });

  it("sits at zero for an empty listing, and highlights nothing", () => {
    const empty = listing("/Users/dev/empty", []);
    const location = movedCursor(movedTo(empty.path), 1, 0);
    expect(location.cursor).toBe(0);
    expect(highlighted(location, empty)).toBeNull();
  });

  it("lands where a pointer clicked, and never past the end", () => {
    const start = movedTo("/Users/dev/code");
    expect(cursorOn(start, 2, 3).cursor).toBe(2);
    expect(cursorOn(start, 9, 3).cursor).toBe(2);
    expect(cursorOn(start, 1, 0).cursor).toBe(0);
  });

  it("names the row it is on", () => {
    const location = movedCursor(movedTo(code.path), 1, code.entries.length);
    expect(highlighted(location, code)?.name).toBe("converse");
  });
});

describe("splitting a typed path", () => {
  it("cuts at the last separator", () => {
    expect(splitTypedPath("/Users/dev/co")).toEqual({ directory: "/Users/dev", prefix: "co" });
    expect(splitTypedPath("/Users/dev/")).toEqual({ directory: "/Users/dev", prefix: "" });
    expect(splitTypedPath("/U")).toEqual({ directory: "/", prefix: "U" });
    expect(splitTypedPath("dev")).toEqual({ directory: "", prefix: "dev" });
  });
});

describe("completion", () => {
  it("offers the current directory's matching children, case-insensitively", () => {
    const names = completionsFor("/Users/dev/code/CO", code).map((entry) => entry.name);
    expect(names).toEqual(["compose", "converse"]);
  });

  it("offers nothing while the field is only showing where the picker is", () => {
    expect(completionsFor(null, code)).toEqual([]);
  });

  it("offers nothing for a path in some other directory", () => {
    expect(completionsFor("/Users/other/co", code)).toEqual([]);
  });

  it("treats a trailing separator as the directory itself, and offers nothing there", () => {
    expect(completionsFor("/Users/dev/code/", code)).toEqual([]);
  });

  it("stops offering a name once it is typed out in full", () => {
    const names = completionsFor("/Users/dev/code/compose", code).map((entry) => entry.name);
    expect(names).toEqual([]);
  });

  it("offers nothing before a listing has arrived", () => {
    expect(completionsFor("/Users/dev/co", null)).toEqual([]);
  });
});

describe("the breadcrumb", () => {
  it("walks the path from the root down, one crumb per segment", () => {
    expect(breadcrumbFor("/Users/dev/code")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "dev", path: "/Users/dev" },
      { label: "code", path: "/Users/dev/code" },
    ]);
  });

  it("is the root alone at the root", () => {
    expect(breadcrumbFor("/")).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("the keyboard", () => {
  const inField = (key: string, draftEmpty = false) =>
    pickerKeyAction({ key, inPathField: true, draftEmpty });
  const inList = (key: string) => pickerKeyAction({ key, inPathField: false, draftEmpty: false });

  it("moves with the arrows from either side", () => {
    expect(inField("ArrowDown")).toBe("cursor-down");
    expect(inList("ArrowDown")).toBe("cursor-down");
    expect(inList("ArrowUp")).toBe("cursor-up");
  });

  it("descends on Enter in the list and navigates on Enter in the field", () => {
    expect(inList("Enter")).toBe("descend");
    expect(inField("Enter")).toBe("navigate-typed");
  });

  it("goes up on Backspace only when there is no text to delete", () => {
    expect(inField("Backspace")).toBeNull();
    expect(inField("Backspace", true)).toBe("up");
    expect(inList("Backspace")).toBe("up");
  });

  it("leaves Escape to the dialog itself, and ignores ordinary typing", () => {
    expect(inField("Escape")).toBeNull();
    expect(inList("Escape")).toBeNull();
    expect(inField("a")).toBeNull();
  });
});
