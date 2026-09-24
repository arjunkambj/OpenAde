import { describe, expect, it } from "vitest";

import { makeCommandRegistry } from "./command-registry";

describe("command registration", () => {
  it("lets the newest claimant answer", () => {
    const registry = makeCommandRegistry();
    const calls: Array<string> = [];
    registry.register("commandPalette.toggle", () => calls.push("root"));
    registry.register("commandPalette.toggle", () => calls.push("settings"));
    registry.resolve("commandPalette.toggle")?.();
    expect(calls).toEqual(["settings"]);
  });

  it("hands the command back when the newer claimant releases it", () => {
    // The regression: two SearchProviders claimed the same four ids. The
    // second overwrote the first, and its unmount deleted the only entry —
    // Cmd+K, Cmd+N, Cmd+Shift+S and Cmd+, were dead on every route afterwards.
    const registry = makeCommandRegistry();
    const calls: Array<string> = [];
    registry.register("thread.new", () => calls.push("root"));
    const release = registry.register("thread.new", () => calls.push("settings"));
    release();
    registry.resolve("thread.new")?.();
    expect(calls).toEqual(["root"]);
    expect(registry.has("thread.new")).toBe(true);
  });

  it("releases by identity, so an out-of-order unmount keeps the winner", () => {
    const registry = makeCommandRegistry();
    const calls: Array<string> = [];
    const releaseFirst = registry.register("thread.interrupt", () => calls.push("view"));
    registry.register("thread.interrupt", () => calls.push("composer"));
    releaseFirst();
    registry.resolve("thread.interrupt")?.();
    expect(calls).toEqual(["composer"]);
  });

  it("reports an id nobody answers, so the palette can leave the row out", () => {
    const registry = makeCommandRegistry();
    const release = registry.register("sidebar.toggle", () => {});
    expect(registry.has("sidebar.toggle")).toBe(true);
    release();
    expect(registry.has("sidebar.toggle")).toBe(false);
    expect(registry.resolve("sidebar.toggle")).toBeUndefined();
  });

  it("is a no-op when the same release is called twice", () => {
    const registry = makeCommandRegistry();
    const release = registry.register("thread.new", () => {});
    const other = registry.register("thread.new", () => {});
    release();
    release();
    expect(registry.has("thread.new")).toBe(true);
    other();
    expect(registry.has("thread.new")).toBe(false);
  });
});

describe("context flags", () => {
  it("reads the value live, so a publisher does not have to re-register", () => {
    const registry = makeCommandRegistry();
    let running = false;
    registry.publish("turnRunning", () => running);
    expect(registry.flag("turnRunning")).toBe(false);
    running = true;
    expect(registry.flag("turnRunning")).toBe(true);
  });

  it("keeps the flag while another publisher is still mounted", () => {
    // The regression: `turnRunning` is published by both ThreadView and the
    // Composer, and the old cleanup deleted the entry unconditionally — one
    // unmount dropped the flag out from under the other.
    const registry = makeCommandRegistry();
    registry.publish("turnRunning", () => true);
    const release = registry.publish("turnRunning", () => true);
    release();
    expect(registry.flag("turnRunning")).toBe(true);
  });

  it("answers undefined for a flag nobody publishes", () => {
    const registry = makeCommandRegistry();
    const release = registry.publish("turnRunning", () => true);
    release();
    expect(registry.flag("turnRunning")).toBeUndefined();
  });
});
