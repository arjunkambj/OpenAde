/**
 * What a connector card says about its instance's probe: a status badge for
 * the header, and a line under it with what the probe found — binary,
 * version, account, model count — plus the command that fixes a signed-out or
 * missing harness and a link for an account-shaped failure. The state and the
 * command come from `connectorHealth`, so nothing here knows a harness.
 */

import { Badge } from "@OpenAde/ui/components/badge";
import { Button } from "@OpenAde/ui/components/button";
import type { ConnectorSummary } from "@OpenAde/contracts/connectors";

import { CopyCommand } from "@/components/copy-command";
import { connectorHealth, type ConnectorHealthState } from "@/lib/connector-health";
import { openExternal } from "@/lib/desktop";

import { helpUrlFor } from "./probe-help";
import { Spinner } from "@honeyicons/react";

const HEALTH_LABEL: Record<ConnectorHealthState, string> = {
  ready: "Ready",
  probing: "Probing…",
  "not-installed": "Not installed",
  "signed-out": "Not signed in",
  error: "Error",
};

export function ConnectorStatusBadge({ summary }: { readonly summary: ConnectorSummary }) {
  const { state } = connectorHealth(summary);
  return (
    <Badge
      variant={state === "ready" ? "secondary" : state === "probing" ? "outline" : "destructive"}
    >
      {state === "probing" ? <Spinner /> : null}
      {HEALTH_LABEL[state]}
    </Badge>
  );
}

export function ConnectorStatusLine({
  summary,
  docsUrl,
}: {
  readonly summary: ConnectorSummary;
  readonly docsUrl: string | null;
}) {
  const { probe } = summary;
  const health = connectorHealth(summary);
  const details = [
    probe.binaryPath,
    probe.version === undefined ? undefined : `v${probe.version}`,
    probe.account,
    probe.modelCount === undefined ? undefined : `${probe.modelCount} models`,
  ].filter((part): part is string => part !== undefined);
  const helpUrl = helpUrlFor(probe, docsUrl);
  // A signed-out probe's own message only repeats the command shown beside it.
  const message =
    health.state === "signed-out" && health.command !== null ? null : (probe.message ?? null);

  if (details.length === 0 && message === null && health.command === null && helpUrl === null) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-xs">
      {details.map((detail) => (
        <span key={detail} className="text-muted-foreground">
          {detail}
        </span>
      ))}
      {message === null ? null : <span className="text-removed">{message}</span>}
      {health.command === null ? null : (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {health.state === "not-installed" ? "Install with" : "Sign in with"}
          <CopyCommand command={health.command} />
        </span>
      )}
      {helpUrl === null ? null : (
        <Button type="button" variant="link" size="xs" onClick={() => openExternal(helpUrl)}>
          Resolve
        </Button>
      )}
    </div>
  );
}
