import { describe, expect, it } from "vitest";

import type { ConnectorCapabilities } from "@OpenAde/contracts/runtime";

import { canSteer, sendMode } from "./send-mode";

const capabilities = (steering: boolean): ConnectorCapabilities => ({
  modelSwitch: "per-turn",
  effortSwitch: "per-turn",
  steering,
  planMode: true,
  subagents: false,
  images: true,
  resume: true,
  fork: false,
  interrupt: "turn",
  rollback: false,
  compaction: false,
  questions: true,
  runtimeModes: ["approval-required"],
  attachments: "files",
});

describe("canSteer", () => {
  it("steers only a running turn on a harness that can take a message mid-turn", () => {
    expect(canSteer(true, capabilities(true))).toBe(true);
    expect(canSteer(false, capabilities(true))).toBe(false);
    expect(canSteer(true, capabilities(false))).toBe(false);
  });

  it("reads unknown capabilities as no steering", () => {
    // Before the thread's session has bound and said what it can do — the
    // decider queues a steer then, so the composer queues too.
    expect(canSteer(true, null)).toBe(false);
    expect(canSteer(true, undefined)).toBe(false);
  });
});

describe("sendMode", () => {
  it("starts a turn from an idle thread", () => {
    expect(sendMode({ running: false, steerable: false, queueChord: false })).toBe("start");
  });

  it("queues with the chord on an idle thread, as it always has", () => {
    expect(sendMode({ running: false, steerable: false, queueChord: true })).toBe("queue");
  });

  it("queues behind a running turn when the harness cannot steer", () => {
    expect(sendMode({ running: true, steerable: false, queueChord: false })).toBe("queue");
    expect(sendMode({ running: true, steerable: false, queueChord: true })).toBe("queue");
  });

  it("steers a running turn with Enter when the harness can", () => {
    expect(sendMode({ running: true, steerable: true, queueChord: false })).toBe("steer");
  });

  it("still queues with the chord when the harness can steer", () => {
    expect(sendMode({ running: true, steerable: true, queueChord: true })).toBe("queue");
  });

  it("never steers a thread that is not running", () => {
    // `canSteer` never yields this pair; the send mode still refuses it.
    expect(sendMode({ running: false, steerable: true, queueChord: false })).toBe("start");
    expect(sendMode({ running: false, steerable: true, queueChord: true })).toBe("queue");
  });
});
