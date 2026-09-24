import { describe, expect, it } from "vitest";

import { decideChord, parseChords, type ChordInput, type GuestChord } from "./guestChords";

const chord = (command: string, key: string, extra: Partial<GuestChord> = {}): GuestChord => ({
  command,
  key,
  meta: true,
  control: false,
  alt: false,
  shift: false,
  ...extra,
});

/** The defaults as a macOS renderer resolves them. */
const MAC: ReadonlyArray<GuestChord> = [
  chord("browser.focusAddress", "l"),
  chord("browser.reload", "r"),
  chord("browser.back", "["),
  chord("browser.forward", "]"),
];

const keyDown = (key: string, extra: Partial<ChordInput> = {}): ChordInput => ({
  type: "keyDown",
  key,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...extra,
});

describe("decideChord", () => {
  it("maps Cmd+R in a guest to browser.reload, handled", () => {
    expect(decideChord(MAC, keyDown("r", { meta: true }), "darwin")).toEqual({
      kind: "handled",
      command: "browser.reload",
    });
    expect(decideChord(MAC, keyDown("[", { meta: true }), "darwin")).toEqual({
      kind: "handled",
      command: "browser.back",
    });
    expect(decideChord(MAC, keyDown("L", { meta: true }), "darwin")).toEqual({
      kind: "handled",
      command: "browser.focusAddress",
    });
  });

  it("lets unbound keys through to the page", () => {
    expect(decideChord(MAC, keyDown("r"), "darwin")).toEqual({ kind: "pass" });
    expect(decideChord(MAC, keyDown("a", { meta: true }), "darwin")).toEqual({ kind: "pass" });
    expect(decideChord(MAC, keyDown("l", { meta: true, alt: true }), "darwin")).toEqual({
      kind: "pass",
    });
    // Only keyDown is matched: keyUp and char would act twice.
    expect(decideChord(MAC, { ...keyDown("r", { meta: true }), type: "keyUp" }, "darwin")).toEqual({
      kind: "pass",
    });
  });

  it("swallows the menu's window reload in a guest even when nothing binds it", () => {
    expect(decideChord([], keyDown("r", { meta: true }), "darwin")).toEqual({
      kind: "handled",
      command: null,
    });
    expect(decideChord([], keyDown("R", { meta: true, shift: true }), "darwin")).toEqual({
      kind: "handled",
      command: null,
    });
    expect(decideChord([], keyDown("r", { control: true }), "linux")).toEqual({
      kind: "handled",
      command: null,
    });
    // Control+R on macOS is not the menu's chord.
    expect(decideChord([], keyDown("r", { control: true }), "darwin")).toEqual({ kind: "pass" });
  });

  it("relays a held chord once", () => {
    expect(decideChord(MAC, keyDown("r", { meta: true, isAutoRepeat: true }), "darwin")).toEqual({
      kind: "handled",
      command: null,
    });
  });
});

describe("parseChords", () => {
  it("keeps well-formed browser chords, lowercasing the key", () => {
    expect(parseChords([{ ...chord("browser.reload", "R") }])).toEqual([
      chord("browser.reload", "r"),
    ]);
  });

  it("drops anything else", () => {
    expect(parseChords("nope")).toEqual([]);
    expect(
      parseChords([
        null,
        chord("thread.new", "n"),
        chord("browser.reload; rm", "r"),
        chord("browser.reload", ""),
        chord("browser.reload", "x".repeat(21)),
        { ...chord("browser.reload", "r"), meta: "yes" },
        { command: "browser.reload", key: "r" },
      ]),
    ).toEqual([]);
  });

  it("keeps at most 32", () => {
    const many = Array.from({ length: 40 }, () => chord("browser.reload", "r"));
    expect(parseChords(many)).toHaveLength(32);
  });
});
