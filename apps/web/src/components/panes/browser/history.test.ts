import { describe, expect, it } from "vitest";

import {
  HISTORY_LIMIT,
  historyUrl,
  parseHistory,
  recordVisit,
  withVisit,
  type HistoryEntry,
} from "./history";

const visits = (count: number): ReadonlyArray<HistoryEntry> =>
  Array.from({ length: count }, (_, i) => i).reduce<ReadonlyArray<HistoryEntry>>(
    (entries, i) => recordVisit(entries, `http://localhost:3000/page/${i}`, `Page ${i}`),
    [],
  );

describe("recordVisit", () => {
  it("puts the newest visit first", () => {
    const entries = recordVisit(
      recordVisit([], "http://localhost:5173/", "Home"),
      "http://localhost:5173/about",
      "About",
    );
    expect(entries.map((entry) => entry.url)).toEqual([
      "http://localhost:5173/about",
      "http://localhost:5173/",
    ]);
  });

  it(`keeps at most ${HISTORY_LIMIT} pages, dropping the oldest`, () => {
    const entries = visits(HISTORY_LIMIT + 7);
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]?.url).toBe(`http://localhost:3000/page/${HISTORY_LIMIT + 6}`);
    expect(entries.at(-1)?.url).toBe("http://localhost:3000/page/7");
  });

  it("moves a revisited page to the front instead of listing it twice", () => {
    const entries = recordVisit(visits(3), "http://localhost:3000/page/0", "Page 0 again");
    expect(entries.map((entry) => entry.url)).toEqual([
      "http://localhost:3000/page/0",
      "http://localhost:3000/page/2",
      "http://localhost:3000/page/1",
    ]);
    expect(entries[0]?.title).toBe("Page 0 again");
  });

  it("dedupes the same page written two ways", () => {
    const entries = recordVisit(
      recordVisit([], "http://localhost:3000", "A"),
      "http://localhost:3000/",
      "A",
    );
    expect(entries).toEqual([{ url: "http://localhost:3000/", title: "A" }]);
  });

  it("keeps a page's last title while a revisit is still loading", () => {
    const entries = recordVisit(visits(2), "http://localhost:3000/page/0", "");
    expect(entries[0]).toEqual({ url: "http://localhost:3000/page/0", title: "Page 0" });
  });

  it("returns the same array when the visit changes nothing", () => {
    const entries = visits(2);
    expect(recordVisit(entries, "http://localhost:3000/page/1", "Page 1")).toBe(entries);
  });

  it("remembers http(s) pages only", () => {
    for (const url of [
      "about:blank",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "ftp://example.com/",
      "localhost:3000",
      "",
    ]) {
      expect(historyUrl(url)).toBeNull();
      expect(recordVisit([], url, "x")).toEqual([]);
    }
    expect(historyUrl("https://example.com")).toBe("https://example.com/");
  });
});

describe("withVisit", () => {
  it("keeps each project's history apart", () => {
    const history = withVisit(
      withVisit({}, "project-a", "http://localhost:3000/", "A"),
      "project-b",
      "http://localhost:4000/",
      "B",
    );
    expect(history["project-a"]?.map((entry) => entry.url)).toEqual(["http://localhost:3000/"]);
    expect(history["project-b"]?.map((entry) => entry.url)).toEqual(["http://localhost:4000/"]);
    expect(withVisit(history, "project-a", "about:blank", "")).toBe(history);
  });
});

describe("parseHistory", () => {
  it("reads back what was stored", () => {
    const history = withVisit({}, "p", "http://localhost:3000/", "A");
    expect(parseHistory(JSON.stringify(history))).toEqual(history);
  });

  it("reads nothing from absent, broken or foreign storage", () => {
    expect(parseHistory(null)).toEqual({});
    expect(parseHistory(undefined)).toEqual({});
    expect(parseHistory("{not json")).toEqual({});
    expect(parseHistory("[]")).toEqual({});
    expect(parseHistory('"text"')).toEqual({});
  });

  it("drops malformed and non-web entries, and applies the cap and the dedupe", () => {
    const stored = {
      p: [
        { url: "http://localhost:3000/", title: "A" },
        { url: "javascript:alert(1)", title: "evil" },
        { url: 42, title: "x" },
        "not an entry",
        { url: "http://localhost:3000/", title: "A (older)" },
        ...Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({
          url: `http://localhost:4000/${i}`,
          title: "",
        })),
      ],
      q: "not a list",
    };
    const history = parseHistory(JSON.stringify(stored));
    expect(Object.keys(history)).toEqual(["p"]);
    expect(history.p).toHaveLength(HISTORY_LIMIT);
    expect(history.p?.[0]).toEqual({ url: "http://localhost:3000/", title: "A" });
    expect(history.p?.filter((entry) => entry.url === "http://localhost:3000/")).toHaveLength(1);
    expect(history.p?.some((entry) => entry.url.startsWith("javascript:"))).toBe(false);
  });
});
