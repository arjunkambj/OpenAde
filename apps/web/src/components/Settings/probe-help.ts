/**
 * Where a failing connector probe sends the user.
 *
 * A connector that knows what went wrong says so in `helpUrl` — a harness that
 * exits with a credits/billing code, for instance, should point straight at the
 * page that fixes it. When it does not, the account page is the fallback for
 * everything except a missing binary, which no account page can install. That
 * keeps the guess in one place, and keeps any connector's own domain out of the
 * renderer.
 */

import { ACCOUNT_HELP_URL, type ConnectorProbe } from "@OpenAde/contracts/rpc";

export const helpUrlFor = (probe: ConnectorProbe): string | null => {
  if (probe.status === "ready" || probe.status === "probing") {
    return null;
  }
  if (probe.helpUrl !== undefined) {
    return probe.helpUrl;
  }
  if (probe.status === "not-installed") {
    return null;
  }
  // "not-authenticated", and the plain `error` a credits failure arrives as:
  // anything but a probe that positively saw credentials.
  return probe.auth === "present" ? null : ACCOUNT_HELP_URL;
};
