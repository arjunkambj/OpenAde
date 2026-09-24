import { describe, expect, it } from "vitest";

import { serverEnv } from "./serverEnv";

const KEY = "a".repeat(64);

describe("serverEnv", () => {
  it("carries the bridge origin and launch key under the server-only prefix", () => {
    const env = serverEnv(
      { PATH: "/bin", POSEIDON_HOME: "/tmp/h" },
      {
        packaged: true,
        bridge: { kind: "enabled", origin: "ws://127.0.0.1:5123", launchKey: KEY },
      },
    );
    expect(env).toEqual({
      PATH: "/bin",
      POSEIDON_HOME: "/tmp/h",
      ELECTRON_RUN_AS_NODE: "1",
      POSEIDON_DEV: "",
      POSEIDON_SERVER_BROWSER_BRIDGE: "ws://127.0.0.1:5123",
      POSEIDON_SERVER_BROWSER_BRIDGE_KEY: KEY,
    });
  });

  it("says disabled, with no key, when the bridge is off", () => {
    const env = serverEnv({}, { packaged: false, bridge: { kind: "disabled" } });
    expect(env["POSEIDON_SERVER_BROWSER_BRIDGE"]).toBe("disabled");
    expect(env).not.toHaveProperty("POSEIDON_SERVER_BROWSER_BRIDGE_KEY");
    expect(env["POSEIDON_DEV"]).toBe("1");
  });

  it("never passes an inherited bridge on", () => {
    const inherited = {
      POSEIDON_SERVER_BROWSER_BRIDGE: "ws://127.0.0.1:1",
      POSEIDON_SERVER_BROWSER_BRIDGE_KEY: "stale",
    };
    const off = serverEnv(inherited, { packaged: true, bridge: { kind: "disabled" } });
    expect(off["POSEIDON_SERVER_BROWSER_BRIDGE"]).toBe("disabled");
    expect(off).not.toHaveProperty("POSEIDON_SERVER_BROWSER_BRIDGE_KEY");

    const on = serverEnv(inherited, {
      packaged: true,
      bridge: { kind: "enabled", origin: "ws://127.0.0.1:2", launchKey: KEY },
    });
    expect(on["POSEIDON_SERVER_BROWSER_BRIDGE_KEY"]).toBe(KEY);
  });
});
