import type { ConnectorInstanceId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "vitest";

import { routedConnectorInstanceId } from "./connector-routing";

const instance = (id: string, enabled: boolean): ConnectorSummary => ({
  connectorInstanceId: id as ConnectorInstanceId,
  kind: "harness",
  displayName: id,
  enabled,
  capabilities: null,
  probe: { status: "ready", probedAt: "2026-09-18T00:00:00.000Z" },
});

describe("routedConnectorInstanceId", () => {
  it("uses the bound session's instance once there is one", () => {
    expect(
      routedConnectorInstanceId("bound" as ConnectorInstanceId, [
        instance("first", true),
        instance("bound", true),
      ]),
    ).toBe("bound");
  });

  it("falls back to the first enabled instance before the first turn", () => {
    // The regression: a thread binds a session only on its first turn, and
    // until then the header picker and `/model` asked for a null instance and
    // got an empty model list.
    expect(routedConnectorInstanceId(null, [instance("a", true), instance("b", true)])).toBe("a");
  });

  it("skips disabled instances, the way the server's routing does", () => {
    expect(
      routedConnectorInstanceId(null, [
        instance("off", false),
        instance("on", true),
        instance("later", true),
      ]),
    ).toBe("on");
  });

  it("answers null when nothing is configured or everything is off", () => {
    expect(routedConnectorInstanceId(null, [])).toBeNull();
    expect(routedConnectorInstanceId(undefined, [instance("off", false)])).toBeNull();
  });
});
