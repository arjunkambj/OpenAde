/**
 * Where a failing connector probe sends the user.
 *
 * A connector that knows what went wrong says so in `helpUrl` — a harness that
 * exits with a credits/billing code, for instance, should point straight at the
 * page that fixes it. When it does not, the connector's own docs link (its
 * `metadata.docsUrl`, from `connectors.describe`) is offered only for a failure
 * that plausibly implicates the account: missing credentials, or a harness that
 * ran and refused. A probe that never got that far — no connector registered
 * for the kind, a probe that timed out or crashed, a binary that is not
 * installed — gets no link, because no account page fixes any of those. That
 * keeps the guess in one place, and keeps every connector's own domain out of
 * the renderer: the links arrive over the wire.
 */

import type { ConnectorProbe } from "@poseidon/contracts/connectors";

import { probeHealthState } from "@/lib/connector-health";

/**
 * `fallbackUrl` is where the connector says its own docs live, or `null` when
 * it names none (or the kind is not one this build describes).
 */
export const helpUrlFor = (probe: ConnectorProbe, fallbackUrl: string | null): string | null => {
  const state = probeHealthState(probe);
  if (state === "probing" || state === "ready") {
    return null;
  }
  if (probe.helpUrl !== undefined) {
    return probe.helpUrl;
  }
  if (probe.status === "not-installed" || probe.auth === "present") {
    return null;
  }
  if (probe.status === "not-authenticated" || probe.auth === "absent") {
    return fallbackUrl;
  }
  // A plain `error` with nothing known about credentials. `binaryPath` is the
  // difference between the harness itself refusing — which a credits failure
  // arrives as, until the connector names its own `helpUrl` — and the server
  // never reaching one, which the connector's docs cannot help with.
  return probe.binaryPath === undefined ? null : fallbackUrl;
};
