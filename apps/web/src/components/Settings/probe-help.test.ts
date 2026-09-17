import { ACCOUNT_HELP_URL, type ConnectorProbe } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "vitest";

import { helpUrlFor } from "./probe-help";

const probe = (over: Partial<ConnectorProbe>): ConnectorProbe => ({
  status: "error",
  probedAt: "2026-09-18T00:00:00.000Z",
  ...over,
});

describe("helpUrlFor", () => {
  it("offers nothing while a probe is healthy or still running", () => {
    expect(helpUrlFor(probe({ status: "ready", auth: "present" }))).toBeNull();
    expect(helpUrlFor(probe({ status: "probing" }))).toBeNull();
  });

  it("prefers the link the connector named", () => {
    expect(helpUrlFor(probe({ status: "error", helpUrl: "https://help.example/credits" }))).toBe(
      "https://help.example/credits",
    );
  });

  it("sends an unnamed credits or auth failure to the account page", () => {
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
      ),
    ).toBe(ACCOUNT_HELP_URL);
    expect(helpUrlFor(probe({ status: "not-authenticated", auth: "absent" }))).toBe(
      ACCOUNT_HELP_URL,
    );
  });

  it("does not send a missing binary, or a probe that saw credentials, to billing", () => {
    expect(helpUrlFor(probe({ status: "not-installed" }))).toBeNull();
    expect(helpUrlFor(probe({ status: "error", auth: "present" }))).toBeNull();
  });

  it("offers nothing for a failure the account page cannot fix", () => {
    // The server stamps these itself, with `auth: "unknown"` and no binary: an
    // unregistered kind, a probe that ran out of time, a probe that crashed.
    expect(
      helpUrlFor(
        probe({
          status: "error",
          auth: "unknown",
          message: 'this build has no connector for kind "x"',
        }),
      ),
    ).toBeNull();
    expect(
      helpUrlFor(probe({ status: "error", auth: "unknown", message: "probe timed out" })),
    ).toBeNull();
  });
});
