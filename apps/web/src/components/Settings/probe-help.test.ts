import { ACCOUNT_HELP_URL, type ConnectorProbe } from "@OpenAde/contracts/rpc";
import { describe, expect, it } from "vitest";

import { connectorReady, helpUrlFor } from "./probe-help";

const probe = (over: Partial<ConnectorProbe>): ConnectorProbe => ({
  status: "error",
  probedAt: "2026-09-18T00:00:00.000Z",
  ...over,
});

describe("connectorReady", () => {
  it("is true only when the connector could actually run a turn", () => {
    expect(connectorReady(probe({ status: "ready", auth: "present" }))).toBe(true);
    expect(connectorReady(probe({ status: "ready", auth: "unknown" }))).toBe(true);
  });

  it("is false for installed but signed out", () => {
    // The regression: the cmd probe answers `ready` with `auth: "absent"`
    // whenever `status --json` exits 0 and reports `authenticated: false`, and
    // welcome called that "A connector is ready." beside a row that read
    // "installed, not signed in". The first turn then failed.
    expect(connectorReady(probe({ status: "ready", auth: "absent" }))).toBe(false);
  });

  it("is false for every other probe state", () => {
    expect(connectorReady(probe({ status: "not-installed" }))).toBe(false);
    expect(connectorReady(probe({ status: "not-authenticated", auth: "absent" }))).toBe(false);
    expect(connectorReady(probe({ status: "probing" }))).toBe(false);
    expect(connectorReady(probe({ status: "error" }))).toBe(false);
  });
});

describe("helpUrlFor", () => {
  it("offers nothing while a probe is healthy or still running", () => {
    expect(helpUrlFor(probe({ status: "ready", auth: "present" }))).toBeNull();
    expect(helpUrlFor(probe({ status: "probing" }))).toBeNull();
  });

  it("keeps the Resolve link for a connector that is installed but signed out", () => {
    expect(helpUrlFor(probe({ status: "ready", auth: "absent" }))).toBe(ACCOUNT_HELP_URL);
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
