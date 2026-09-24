import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import {
  clampDrawerHeight,
  DRAWER_HEIGHT_MIN,
  drawerHeightAtom,
  openByThreadAtom,
  parseDrawerHeight,
  parseOpenByThread,
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

describe("clampDrawerHeight", () => {
  it("keeps a height inside the bounds", () => {
    expect(clampDrawerHeight(300, 1000)).toBe(300);
  });

  it("caps at 70% of the thread column", () => {
    expect(clampDrawerHeight(900, 1000)).toBe(700);
  });

  it("never goes below the minimum", () => {
    expect(clampDrawerHeight(40, 1000)).toBe(DRAWER_HEIGHT_MIN);
  });

  it("lets the minimum win in a column too short for both", () => {
    expect(clampDrawerHeight(300, 100)).toBe(DRAWER_HEIGHT_MIN);
  });

  it("rounds a drag's fractional pixels", () => {
    expect(clampDrawerHeight(250.6, 1000)).toBe(251);
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
