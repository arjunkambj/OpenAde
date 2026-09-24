import type { ConnectorProbe } from "@poseidon/contracts/connectors";
import { describe, expect, it } from "vitest";

import { helpUrlFor } from "./probe-help";

const probe = (over: Partial<ConnectorProbe>): ConnectorProbe => ({
  status: "error",
  probedAt: "2026-09-18T00:00:00.000Z",
  ...over,
});

/** The connector's own docs link, as `connectors.describe` would carry it. */
const DOCS_URL = "https://harness.example/docs";

describe("helpUrlFor", () => {
  it("offers nothing while a probe is healthy or still running", () => {
    expect(helpUrlFor(probe({ status: "ready", auth: "present" }), DOCS_URL)).toBeNull();
    expect(helpUrlFor(probe({ status: "probing" }), DOCS_URL)).toBeNull();
  });

  it("keeps the Resolve link for a connector that is installed but signed out", () => {
    expect(helpUrlFor(probe({ status: "ready", auth: "absent" }), DOCS_URL)).toBe(DOCS_URL);
  });

  it("prefers the link the connector named", () => {
    expect(
      helpUrlFor(probe({ status: "error", helpUrl: "https://help.example/credits" }), DOCS_URL),
    ).toBe("https://help.example/credits");
  });

  it("sends an unnamed credits or auth failure to the connector's docs", () => {
    // What an exit-code-10 style credits failure looks like without a helpUrl:
    // the harness ran — it named its binary — and refused.
    expect(
      helpUrlFor(
        probe({
          status: "error",
          auth: "unknown",
          binaryPath: "/usr/local/bin/harness",
          message: "out of credits",
        }),
        DOCS_URL,
      ),
    ).toBe(DOCS_URL);
    expect(helpUrlFor(probe({ status: "not-authenticated", auth: "absent" }), DOCS_URL)).toBe(
      DOCS_URL,
    );
  });

  it("does not send a missing binary, or a probe that saw credentials, to the docs", () => {
    expect(helpUrlFor(probe({ status: "not-installed" }), DOCS_URL)).toBeNull();
    expect(helpUrlFor(probe({ status: "error", auth: "present" }), DOCS_URL)).toBeNull();
  });

  it("offers nothing for a failure the connector's docs cannot fix", () => {
    // The server stamps these itself, with `auth: "unknown"` and no binary: an
    // unregistered kind, a probe that ran out of time, a probe that crashed.
    expect(
      helpUrlFor(
        probe({
          status: "error",
          auth: "unknown",
          message: 'this build has no connector for kind "x"',
        }),
        DOCS_URL,
      ),
    ).toBeNull();
    expect(
      helpUrlFor(probe({ status: "error", auth: "unknown", message: "probe timed out" }), DOCS_URL),
    ).toBeNull();
  });

  it("offers nothing when the connector names no docs link", () => {
    expect(helpUrlFor(probe({ status: "not-authenticated", auth: "absent" }), null)).toBeNull();
    // A link the probe named still wins.
    expect(
      helpUrlFor(probe({ status: "error", helpUrl: "https://help.example/credits" }), null),
    ).toBe("https://help.example/credits");
  });
});
