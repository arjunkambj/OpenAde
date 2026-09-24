import { describe, expect, it } from "vitest";

import { makePointerRelay, pointerOf, type AgentPointer } from "./agentPointer";

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("pointerOf", () => {
  it("reads a move and a press, and nothing else", () => {
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 5 })).toEqual({
      x: 4,
      y: 5,
      kind: "move",
    });
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
      kind: "press",
    });
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 2 })).toBe(null);
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 2 })).toBe(null);
    expect(pointerOf("Input.insertText", { text: "a" })).toBe(null);
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: "4", y: 5 })).toBe(null);
    expect(pointerOf("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number.NaN, y: 5 })).toBe(
      null,
    );
    expect(pointerOf("Input.dispatchMouseEvent", null)).toBe(null);
  });
});

describe("makePointerRelay", () => {
  it("tells every press and thins moves per tab", () => {
    const sent: Array<AgentPointer> = [];
    let now = 0;
    const relay = makePointerRelay({
      send: (p) => sent.push(p),
      now: () => now,
      moveIntervalMs: 50,
    });
    const move = (wcId: number, x: number) =>
      relay(THREAD, wcId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 0 });

    move(1, 10);
    now = 20;
    move(1, 20); // too soon for tab 1
    move(2, 30); // tab 2 has its own clock
    relay(THREAD, 1, "Input.dispatchMouseEvent", { type: "mousePressed", x: 25, y: 0 });
    now = 60;
    move(1, 40);
    relay(THREAD, 1, "Input.insertText", { text: "a" });

    expect(sent).toEqual([
      { threadId: THREAD, wcId: 1, x: 10, y: 0, kind: "move" },
      { threadId: THREAD, wcId: 2, x: 30, y: 0, kind: "move" },
      { threadId: THREAD, wcId: 1, x: 25, y: 0, kind: "press" },
      { threadId: THREAD, wcId: 1, x: 40, y: 0, kind: "move" },
    ]);
  });
});
