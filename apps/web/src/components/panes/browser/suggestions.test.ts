import type { DevServer } from "@poseidon/contracts/rpc";
import { describe, expect, it } from "vitest";

import type { HistoryEntry } from "./history";
import { HISTORY_SUGGESTIONS, moveActive, suggestionsFor } from "./suggestions";

const servers: ReadonlyArray<DevServer> = [
  { url: "http://localhost:3000", port: 3000, processName: "next-server" },
  { url: "http://localhost:5173", port: 5173, processName: "node" },
];
const history: ReadonlyArray<HistoryEntry> = [
  { url: "http://localhost:5173/settings", title: "Settings" },
  { url: "http://localhost:3000/", title: "Home" },
  { url: "https://example.com/docs", title: "" },
];

const urls = (list: ReadonlyArray<{ readonly url: string }>) => list.map((entry) => entry.url);

describe("suggestionsFor", () => {
  it("offers every server, then recent pages, with nothing typed", () => {
    const list = suggestionsFor("", "", servers, history);
    expect(list.map((entry) => entry.kind)).toEqual(["server", "server", "history", "history"]);
    // The root of a server it already offers is not listed again.
    expect(urls(list)).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5173/settings",
      "https://example.com/docs",
    ]);
    expect(list[0]).toMatchObject({ label: "http://localhost:3000", detail: "next-server" });
    expect(list[2]).toMatchObject({ label: "Settings", detail: "http://localhost:5173/settings" });
    expect(list[3]).toMatchObject({ label: "https://example.com/docs", detail: null });
  });

  it("does not narrow while the field still shows the current page", () => {
    const current = "http://localhost:5173/settings";
    expect(suggestionsFor(current, current, servers, history)).toHaveLength(4);
  });

  it("narrows by url, title, port or process name, ignoring case", () => {
    expect(urls(suggestionsFor("SETT", "", servers, history))).toEqual([
      "http://localhost:5173/settings",
    ]);
    expect(urls(suggestionsFor("3000", "", servers, history))).toEqual(["http://localhost:3000"]);
    expect(urls(suggestionsFor("next", "", servers, history))).toEqual(["http://localhost:3000"]);
    expect(urls(suggestionsFor("example", "", servers, history))).toEqual([
      "https://example.com/docs",
    ]);
    expect(suggestionsFor("nothing like it", "", servers, history)).toEqual([]);
  });

  it(`offers at most ${HISTORY_SUGGESTIONS} visited pages`, () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `http://localhost:4000/${i}`,
      title: `Page ${i}`,
    }));
    const list = suggestionsFor("", "", [], many);
    expect(list).toHaveLength(HISTORY_SUGGESTIONS);
    expect(list[0]?.url).toBe("http://localhost:4000/0");
  });
});

describe("moveActive", () => {
  const list = suggestionsFor("", "", servers, history);

  it("goes down from none to the first and up from none to the last", () => {
    expect(moveActive(list, null, "down")).toBe(list[0]!.url);
    expect(moveActive(list, null, "up")).toBe(list.at(-1)!.url);
  });

  it("steps through, and past either end back to what was typed", () => {
    expect(moveActive(list, list[0]!.url, "down")).toBe(list[1]!.url);
    expect(moveActive(list, list[1]!.url, "up")).toBe(list[0]!.url);
    expect(moveActive(list, list[0]!.url, "up")).toBeNull();
    expect(moveActive(list, list.at(-1)!.url, "down")).toBeNull();
  });

  it("starts over when the active one is no longer offered, and has nothing to move through when empty", () => {
    expect(moveActive(list, "http://gone/", "down")).toBe(list[0]!.url);
    expect(moveActive([], null, "down")).toBeNull();
  });
});
