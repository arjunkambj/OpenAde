import { describe, expect, it } from "vitest";

import { emptyFilesView, openedPreview, withFilesView } from "./files-view";

const thread = "0199c0de-0002-7000-8000-000000000001";

describe("withFilesView", () => {
  it("keeps a thread's search and open file", () => {
    const view = { ...emptyFilesView, query: "router", preview: openedPreview("src/router.ts") };
    expect(withFilesView({}, thread, view)).toEqual({ [thread]: view });
  });

  it("drops a thread whose view went back to blank", () => {
    const views = { [thread]: { ...emptyFilesView, query: "x" } };
    expect(withFilesView(views, thread, emptyFilesView)).toEqual({});
  });

  it("returns the same map when nothing changed", () => {
    const view = { ...emptyFilesView, listScroll: 120 };
    const views = { [thread]: view };
    expect(withFilesView(views, thread, view)).toBe(views);
    const none = {};
    expect(withFilesView(none, thread, emptyFilesView)).toBe(none);
  });
});

describe("openedPreview", () => {
  it("starts a file at its first page, scrolled to the top", () => {
    expect(openedPreview("a.ts")).toEqual({ path: "a.ts", offset: 0, visited: [], scroll: 0 });
  });
});
