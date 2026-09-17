import { describe, expect, it } from "vitest";

import { footerConnection, serverLabel } from "./sidebar-footer-state";

describe("serverLabel", () => {
  it("reduces a socket url to host and port", () => {
    expect(serverLabel("ws://127.0.0.1:53211/ws")).toBe("127.0.0.1:53211");
    expect(serverLabel("wss://localhost:8443/ws")).toBe("localhost:8443");
  });

  it("answers null when no channel resolved a server", () => {
    expect(serverLabel(null)).toBeNull();
    expect(serverLabel(undefined)).toBeNull();
    expect(serverLabel("")).toBeNull();
  });

  it("passes an unparseable url through rather than dropping it", () => {
    expect(serverLabel("not a url")).toBe("not a url");
  });
});

describe("footerConnection", () => {
  it("names every connection status", () => {
    const statuses = [
      "connecting",
      "connected",
      "reconnecting",
      "disconnected",
      "incompatible",
    ] as const;
    for (const status of statuses) {
      const state = footerConnection(status, "ws://127.0.0.1:1/ws");
      expect(state.label).not.toBe("");
      expect(state.dot).not.toBe("");
      expect(state.detail).toBe("127.0.0.1:1");
    }
  });

  it("distinguishes a live socket from a missing one", () => {
    expect(footerConnection("connected", "ws://h:1/ws").label).toBe("Connected");
    expect(footerConnection("disconnected", null)).toEqual({
      label: "No server",
      detail: null,
      dot: "bg-removed",
    });
  });
});
