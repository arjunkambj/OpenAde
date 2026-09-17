import { describe, expect, it } from "vitest";

import { randomCdpPort, resolveCdpPort } from "./cdp";

const never = (): number => {
  throw new Error("a random port was allocated when none should have been");
};

describe("resolveCdpPort", () => {
  it("opens no port by default", () => {
    expect(resolveCdpPort({}, never)).toBeNull();
    expect(resolveCdpPort({ OPENADE_CDP_PORT: "", OPENADE_BROWSER_PANE: "" }, never)).toBeNull();
    expect(resolveCdpPort({ OPENADE_BROWSER_PANE: "0" }, never)).toBeNull();
  });

  it("opens a random high port when the browser pane is enabled", () => {
    expect(resolveCdpPort({ OPENADE_BROWSER_PANE: "1" }, () => 31_337)).toBe(31_337);
    expect(resolveCdpPort({ OPENADE_BROWSER_PANE: "true" }, () => 31_337)).toBe(31_337);
  });

  it("opens a random high port when the persisted setting enables the pane", () => {
    expect(resolveCdpPort({}, () => 31_337, true)).toBe(31_337);
    expect(resolveCdpPort({}, never, false)).toBeNull();
  });

  it("lets the kill switch win over the persisted setting too", () => {
    expect(resolveCdpPort({ OPENADE_REMOTE_DEBUG: "0" }, never, true)).toBeNull();
  });

  it("pins the port when one is given", () => {
    expect(resolveCdpPort({ OPENADE_CDP_PORT: "4444" }, never)).toBe(4444);
    expect(resolveCdpPort({ OPENADE_REMOTE_DEBUG: "1" }, never)).toBe(9222);
    expect(resolveCdpPort({ OPENADE_REMOTE_DEBUG: "4455" }, never)).toBe(4455);
  });

  it("refuses privileged and malformed ports", () => {
    for (const port of ["0", "80", "1024", "-1", "70000", "nope"]) {
      expect(resolveCdpPort({ OPENADE_CDP_PORT: port }, never)).toBeNull();
    }
  });

  it("lets the kill switch win over every opt-in", () => {
    expect(
      resolveCdpPort(
        { OPENADE_REMOTE_DEBUG: "0", OPENADE_BROWSER_PANE: "1", OPENADE_CDP_PORT: "4444" },
        never,
      ),
    ).toBeNull();
  });

  it("allocates an unprivileged high port", () => {
    for (let i = 0; i < 200; i++) {
      const port = randomCdpPort();
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThan(60_000);
    }
  });
});
