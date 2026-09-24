import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import {
  clampDrawerHeight,
  drawerHeightMax,
  handOverDrawerOpen,
  DRAWER_HEIGHT_MIN,
  drawerHeightAtom,
  openByThreadAtom,
  parseDrawerHeight,
  parseOpenByThread,
  TIMELINE_HEIGHT_MIN,
  withDrawerOpen,
} from "./terminal-ui";

describe("parseOpenByThread", () => {
  it("reads the open threads back", () => {
    expect(parseOpenByThread('{"0199c0de-0002-7000-8000-000000000001":true}')).toEqual({
      "0199c0de-0002-7000-8000-000000000001": true,
    });
  });

  it("is empty when nothing was ever stored", () => {
    expect(parseOpenByThread(null)).toEqual({});
    expect(parseOpenByThread(undefined)).toEqual({});
  });

  it("survives storage written by something else", () => {
    expect(parseOpenByThread("not json")).toEqual({});
    expect(parseOpenByThread("[true]")).toEqual({});
    expect(parseOpenByThread("null")).toEqual({});
  });

  it("keeps only entries that are exactly true", () => {
    expect(parseOpenByThread('{"a":true,"b":false,"c":"true","d":1}')).toEqual({ a: true });
  });
});

describe("handOverDrawerOpen", () => {
  const project = "project:p";

  it("opens the thread's drawer and closes the project's when it was open", () => {
    expect(handOverDrawerOpen({ [project]: true, other: true }, project, "t")).toEqual({
      other: true,
      t: true,
    });
  });

  it("leaves a closed drawer closed on both", () => {
    const map = { other: true } as const;
    expect(handOverDrawerOpen(map, project, "t")).toBe(map);
  });
});

describe("withDrawerOpen", () => {
  it("adds an opened thread", () => {
    expect(withDrawerOpen({ a: true }, "b", true)).toEqual({ a: true, b: true });
  });

  it("drops the key of a closed thread", () => {
    expect(withDrawerOpen({ a: true, b: true }, "a", false)).toEqual({ b: true });
  });

  it("returns the same map when nothing changes", () => {
    const map = { a: true } as const;
    expect(withDrawerOpen(map, "a", true)).toBe(map);
    expect(withDrawerOpen(map, "b", false)).toBe(map);
  });

  it("round-trips through storage", () => {
    const map = withDrawerOpen(withDrawerOpen({}, "a", true), "b", true);
    expect(parseOpenByThread(JSON.stringify(map))).toEqual(map);
  });
});

describe("drawerHeightMax", () => {
  it("is the drawer's share of a tall column", () => {
    expect(drawerHeightMax(1000, 100)).toBe(700);
  });

  it("leaves the conversation its floor once the fixed rows take the rest", () => {
    // A 700px column with a 44px header and a 246px composer: at 70% the
    // conversation would get nothing at all.
    const max = drawerHeightMax(700, 44 + 246);
    expect(max).toBe(700 - 44 - 246 - TIMELINE_HEIGHT_MIN);
    expect(700 - 44 - 246 - max).toBe(TIMELINE_HEIGHT_MIN);
  });
});

describe("clampDrawerHeight", () => {
  it("keeps a height inside the bounds", () => {
    expect(clampDrawerHeight(300, 700)).toBe(300);
  });

  it("caps at the bound", () => {
    expect(clampDrawerHeight(900, 700)).toBe(700);
  });

  it("never goes below the minimum", () => {
    expect(clampDrawerHeight(40, 700)).toBe(DRAWER_HEIGHT_MIN);
  });

  it("lets the minimum win when a short column's bound is below it", () => {
    expect(clampDrawerHeight(300, drawerHeightMax(400, 290))).toBe(DRAWER_HEIGHT_MIN);
  });

  it("rounds a drag's fractional pixels", () => {
    expect(clampDrawerHeight(250.6, 700)).toBe(251);
  });
});

describe("parseDrawerHeight", () => {
  it("reads a stored height back", () => {
    expect(parseDrawerHeight("340")).toBe(340);
  });

  it("falls back to the default when nothing usable is stored", () => {
    const fallback = parseDrawerHeight(null);
    expect(parseDrawerHeight(undefined)).toBe(fallback);
    expect(parseDrawerHeight("tall")).toBe(fallback);
    expect(fallback).toBeGreaterThanOrEqual(DRAWER_HEIGHT_MIN);
  });

  it("raises a stored height below the minimum", () => {
    expect(parseDrawerHeight("10")).toBe(DRAWER_HEIGHT_MIN);
  });
});

describe("terminal layout atoms", () => {
  // Remove idle nodes at once, so a missing `keepAlive` shows up here.
  const makeRegistry = () =>
    AtomRegistry.make({
      scheduleTask: (task) => {
        task();
        return () => {};
      },
    });

  it("keep a thread's open drawer after the last subscriber unmounts", () => {
    const registry = makeRegistry();
    const unmount = registry.mount(openByThreadAtom);
    registry.set(openByThreadAtom, { two: true });
    unmount();
    registry.mount(openByThreadAtom);
    expect(registry.get(openByThreadAtom)).toEqual({ two: true });
  });

  it("keep a dragged height after the drawer closes", () => {
    const registry = makeRegistry();
    const unmount = registry.mount(drawerHeightAtom);
    registry.set(drawerHeightAtom, 450);
    unmount();
    registry.mount(drawerHeightAtom);
    expect(registry.get(drawerHeightAtom)).toBe(450);
  });
});
