/**
 * Whether a connector instance can run a turn, read off its probe alone.
 *
 * Every health message the renderer shows — the status badge on the settings
 * card, the banner above the composer — comes from here, built from the
 * summary's display name and the probe's own fields. The commands shown are
 * the ones the connector named (`loginCommand`, `installCommand`); when it
 * named none there is no command, and the renderer never spells one of its
 * own, so no harness's CLI is written into it.
 *
 * `status: "ready"` alone does not mean the instance can run: a harness can
 * report ready while it is signed out (`auth: "absent"`, `authenticated:
 * false`) — installed, reachable, unusable — so signed-out is decided before
 * ready.
 */

import type { ConnectorProbe, ConnectorSummary } from "@OpenAde/contracts/connectors";

export type ConnectorHealthState = "ready" | "probing" | "not-installed" | "signed-out" | "error";

export interface ConnectorHealth {
  readonly state: ConnectorHealthState;
  /** The command that fixes it, as the connector named it; null when it named none. */
  readonly command: string | null;
  /** One sentence for the user, without the command. */
  readonly message: string;
}

/** The state alone, for callers that have a probe but no summary. */
export const probeHealthState = (probe: ConnectorProbe): ConnectorHealthState => {
  if (probe.status === "probing") {
    return "probing";
  }
  if (probe.status === "not-installed") {
    return "not-installed";
  }
  if (
    probe.status === "not-authenticated" ||
    probe.authenticated === false ||
    probe.auth === "absent"
  ) {
    return "signed-out";
  }
  return probe.status === "error" ? "error" : "ready";
};

export const connectorHealth = (summary: ConnectorSummary): ConnectorHealth => {
  const { probe, displayName } = summary;
  const state = probeHealthState(probe);
  switch (state) {
    case "probing":
      return { state, command: null, message: `Checking ${displayName}…` };
    case "not-installed":
      return {
        state,
        command: probe.installCommand ?? null,
        message: `${displayName} is not installed`,
      };
    case "signed-out":
      return {
        state,
        command: probe.loginCommand ?? null,
        message: `${displayName} is not signed in`,
      };
    case "error":
      return {
        state,
        command: null,
        message:
          probe.message === undefined || probe.message.trim() === ""
            ? `${displayName} cannot run right now`
            : `${displayName}: ${probe.message}`,
      };
    case "ready":
      return { state, command: null, message: `${displayName} is ready` };
  }
};
