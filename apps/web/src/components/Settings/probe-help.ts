/**
 * Where a failing connector probe sends the user.
 *
 * A connector that knows what went wrong says so in `helpUrl` — a harness that
 * exits with a credits/billing code, for instance, should point straight at the
 * page that fixes it. When it does not, the account page is offered only for a
 * failure that plausibly implicates the account: missing credentials, or a
 * harness that ran and refused. A probe that never got that far — no connector
 * registered for the kind, a probe that timed out or crashed, a binary that is
 * not installed — gets no link, because no account page fixes any of those.
 * That keeps the guess in one place, and keeps any connector's own domain out
 * of the renderer.
 */

import { ACCOUNT_HELP_URL, type ConnectorProbe } from "@OpenAde/contracts/rpc";

export const helpUrlFor = (probe: ConnectorProbe): string | null => {
  if (probe.status === "ready" || probe.status === "probing") {
    return null;
  }
  if (probe.helpUrl !== undefined) {
    return probe.helpUrl;
  }
  if (probe.status === "not-installed" || probe.auth === "present") {
    return null;
  }
  if (probe.status === "not-authenticated" || probe.auth === "absent") {
    return ACCOUNT_HELP_URL;
  }
  // A plain `error` with nothing known about credentials. `binaryPath` is the
  // difference between the harness itself refusing — which a credits failure
  // arrives as, until the connector names its own `helpUrl` — and the server
  // never reaching one, which the account page cannot help with.
  return probe.binaryPath === undefined ? null : ACCOUNT_HELP_URL;
};
