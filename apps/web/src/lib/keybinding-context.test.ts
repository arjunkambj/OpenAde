import { describe, expect, it } from "vitest";

import { keybindingContext, type FocusSnapshot } from "./keybinding-context";

const snapshot = (patch: Partial<FocusSnapshot> = {}): FocusSnapshot => ({
  editable: false,
  surface: undefined,
  overlayOpen: false,
  ...patch,
});

/** A registry reader over a fixed set of published flags, logging each read. */
const published = (flags: Readonly<Record<string, boolean | string>>) => {
  const reads: Array<string> = [];
  return {
    reads,
    read: (name: string) => {
      reads.push(name);
      return flags[name];
    },
  };
};

describe("keybindingContext", () => {
  it("reads focus in the composer as composer and input focus", () => {
    const context = keybindingContext(
      snapshot({ editable: true, surface: "composer" }),
      published({}).read,
      true,
    );
    expect(context("inputFocus")).toBe(true);
    expect(context("composerFocus")).toBe(true);
    expect(context("terminalFocus")).toBe(false);
    expect(context("browserFocus")).toBe(false);
    expect(context("dialogOpen")).toBe(false);
  });

  it("names the terminal and browser surfaces", () => {
    const terminal = keybindingContext(snapshot({ surface: "terminal" }), () => undefined, false);
    expect(terminal("terminalFocus")).toBe(true);
    expect(terminal("composerFocus")).toBe(false);
    const browser = keybindingContext(snapshot({ surface: "browser" }), () => undefined, false);
    expect(browser("browserFocus")).toBe(true);
  });

  it("reports an open dialog", () => {
    const context = keybindingContext(snapshot({ overlayOpen: true }), () => undefined, false);
    expect(context("dialogOpen")).toBe(true);
    expect(context("inputFocus")).toBe(false);
  });

  it("answers isMac from the platform", () => {
    expect(keybindingContext(snapshot(), () => undefined, true)("isMac")).toBe(true);
    expect(keybindingContext(snapshot(), () => undefined, false)("isMac")).toBe(false);
  });

  it("never lets a published flag stand in for a built-in", () => {
    const flags = published({ inputFocus: true, dialogOpen: true, isMac: true });
    const context = keybindingContext(snapshot(), flags.read, false);
    expect(context("inputFocus")).toBe(false);
    expect(context("dialogOpen")).toBe(false);
    expect(context("isMac")).toBe(false);
    expect(flags.reads).toEqual([]);
  });

  it("reads everything else from the registry", () => {
    const context = keybindingContext(
      snapshot(),
      published({ approvalPending: true, threadOpen: true }).read,
      false,
    );
    expect(context("approvalPending")).toBe(true);
    expect(context("threadOpen")).toBe(true);
    expect(context("planPending")).toBeUndefined();
  });

  it("reads the threadRunning alias as turnRunning", () => {
    const flags = published({ turnRunning: true });
    const context = keybindingContext(snapshot(), flags.read, false);
    expect(context("threadRunning")).toBe(true);
    expect(flags.reads).toEqual(["turnRunning"]);
  });
});
