import { describe, expect, it } from "vitest";

import {
  captureWindowState,
  clampToDisplays,
  DEFAULT_WINDOW_STATE,
  parseWindowState,
  type Rect,
  type WindowState,
} from "./windowState";

const LAPTOP: Rect = { x: 0, y: 25, width: 1512, height: 920 };
const EXTERNAL: Rect = { x: 1512, y: 0, width: 2560, height: 1440 };

describe("parseWindowState", () => {
  it("reads back what was written", () => {
    const state: WindowState = {
      x: 12,
      y: 34,
      width: 1000,
      height: 700,
      maximized: true,
      fullScreen: false,
    };
    expect(parseWindowState(JSON.stringify(state))).toEqual(state);
  });

  it("defaults the flags for a document written before they existed", () => {
    expect(parseWindowState(JSON.stringify({ x: 1, y: 2, width: 800, height: 600 }))).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
      maximized: false,
      fullScreen: false,
    });
  });

  it("falls back to the default geometry for anything unreadable", () => {
    expect(parseWindowState("")).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState("{ not json")).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState("null")).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState('"nope"')).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState(JSON.stringify({ width: "wide", x: null }))).toEqual(
      DEFAULT_WINDOW_STATE,
    );
  });
});

describe("clampToDisplays", () => {
  const state = (x: number, y: number): WindowState => ({
    x,
    y,
    width: 1000,
    height: 700,
    maximized: false,
    fullScreen: true,
  });

  it("keeps a position that still overlaps a display", () => {
    expect(clampToDisplays(state(40, 60), [LAPTOP, EXTERNAL])).toEqual(state(40, 60));
    expect(clampToDisplays(state(1600, 100), [LAPTOP, EXTERNAL])).toEqual(state(1600, 100));
  });

  it("drops a position left behind by a disconnected display, flags intact", () => {
    expect(clampToDisplays(state(1600, 100), [LAPTOP])).toEqual({
      width: 1000,
      height: 700,
      maximized: false,
      fullScreen: true,
    });
  });

  it("leaves a state with no position alone", () => {
    expect(clampToDisplays(DEFAULT_WINDOW_STATE, [])).toEqual(DEFAULT_WINDOW_STATE);
  });
});

describe("captureWindowState", () => {
  it("records the restore rect together with the maximized and fullscreen flags", () => {
    const normal: Rect = { x: 10, y: 20, width: 1280, height: 820 };
    expect(
      captureWindowState({
        isMaximized: () => false,
        isFullScreen: () => true,
        getNormalBounds: () => normal,
      }),
    ).toEqual({ ...normal, maximized: false, fullScreen: true });

    expect(
      captureWindowState({
        isMaximized: () => true,
        isFullScreen: () => false,
        getNormalBounds: () => normal,
      }),
    ).toEqual({ ...normal, maximized: true, fullScreen: false });
  });
});
