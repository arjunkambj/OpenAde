import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { scrollWithin } from "./scroll-within";

const scroller = (scrollTop: number, top: number, clientHeight: number) => ({
  scrollTop,
  clientHeight,
  getBoundingClientRect: () => ({ top }),
});

const target = (top: number, height: number) => ({
  getBoundingClientRect: () => ({ top, height }),
  scrollIntoView: vi.fn(),
});

describe("scrollWithin", () => {
  it("puts the target's top at the scroller's top", () => {
    const box = scroller(100, 50, 400);
    scrollWithin(box, target(250, 20));
    expect(box.scrollTop).toBe(300);
  });

  it("centres the target in the scroller's visible height", () => {
    const box = scroller(100, 50, 400);
    scrollWithin(box, target(250, 20), "center");
    // 200 below the top, less half of what the row leaves free: (400 - 20) / 2.
    expect(box.scrollTop).toBe(100 + 200 - 190);
  });

  it("moves only the scroller, never its clipping ancestors", () => {
    const box = scroller(0, 0, 400);
    const row = target(900, 20);
    scrollWithin(box, row, "center");
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves the scroller alone without a target", () => {
    const box = scroller(120, 0, 400);
    scrollWithin(box, undefined, "center");
    expect(box.scrollTop).toBe(120);
  });
});

// Every dock pane mounts while the dock animates open, so none of them may
// reveal with `scrollIntoView`; they go through `scrollWithin` instead.
describe("dock panes", () => {
  const panes = fileURLToPath(new URL("../components/panes", import.meta.url));
  const sources = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("never call scrollIntoView", () => {
    const offenders = sources(panes).filter((path) =>
      readFileSync(path, "utf8").includes(".scrollIntoView("),
    );
    expect(offenders).toEqual([]);
  });
});
