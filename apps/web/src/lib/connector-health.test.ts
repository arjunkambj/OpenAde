import type { ConnectorProbe, ConnectorSummary } from "@OpenAde/contracts/connectors";
import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import { describe, expect, it } from "vitest";

import { connectorHealth, probeHealthState } from "./connector-health";

const summary = (probe: Partial<ConnectorProbe>): ConnectorSummary => ({
  connectorInstanceId: "instance" as ConnectorInstanceId,
  kind: "harness",
  displayName: "Harness",
  enabled: true,
  capabilities: null,
  extensions: { skills: false, plugins: false, mcpServers: false },
  probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z", ...probe },
});

describe("connectorHealth", () => {
  it("is ready when the probe is ready and signed in, with nothing to run", () => {
    expect(
      connectorHealth(summary({ installed: true, auth: "present", authenticated: true })),
    ).toEqual({ state: "ready", command: null, message: "Harness is ready" });
    // A probe that could not tell about credentials is not held against it.
    expect(connectorHealth(summary({ installed: true, auth: "unknown" })).state).toBe("ready");
  });

  it("is probing while the first probe has not landed", () => {
    const health = connectorHealth(summary({ status: "probing" }));
    expect(health.state).toBe("probing");
    expect(health.command).toBeNull();
  });

  it("offers the install command the connector named when nothing is installed", () => {
    expect(
      connectorHealth(
        summary({ status: "not-installed", installed: false, installCommand: "harness install" }),
      ),
    ).toEqual({
      state: "not-installed",
      command: "harness install",
      message: "Harness is not installed",
    });
    // No command named, none invented.
    expect(connectorHealth(summary({ status: "not-installed" })).command).toBeNull();
  });

  it("offers the login command the connector named when signed out", () => {
    expect(
      connectorHealth(
        summary({
          status: "not-authenticated",
          installed: true,
          auth: "absent",
          authenticated: false,
          loginCommand: "harness login",
        }),
      ),
    ).toEqual({
      state: "signed-out",
      command: "harness login",
      message: "Harness is not signed in",
    });
  });

  it("treats a ready probe that is signed out as signed out", () => {
    // A harness can answer ready while its credentials are absent — installed,
    // reachable and unable to run a turn.
    expect(connectorHealth(summary({ status: "ready", auth: "absent" })).state).toBe("signed-out");
    expect(connectorHealth(summary({ status: "ready", authenticated: false })).state).toBe(
      "signed-out",
    );
  });

  it("reports an error with the probe's own message and no command", () => {
    expect(
      connectorHealth(summary({ status: "error", installed: true, message: "rate limited" })),
    ).toEqual({ state: "error", command: null, message: "Harness: rate limited" });
    expect(connectorHealth(summary({ status: "error", installed: false })).message).toBe(
      "Harness cannot run right now",
    );
  });
});

describe("probeHealthState", () => {
  it("answers the same states from a bare probe", () => {
    const probe = (over: Partial<ConnectorProbe>): ConnectorProbe => ({
      status: "ready",
      probedAt: "2026-09-18T00:00:00.000Z",
      ...over,
    });
    expect(probeHealthState(probe({}))).toBe("ready");
    expect(probeHealthState(probe({ status: "probing" }))).toBe("probing");
    expect(probeHealthState(probe({ status: "not-installed" }))).toBe("not-installed");
    expect(probeHealthState(probe({ status: "not-authenticated" }))).toBe("signed-out");
    expect(probeHealthState(probe({ status: "error" }))).toBe("error");
  });
});
