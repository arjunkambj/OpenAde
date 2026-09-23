/**
 * The banner above the composer when the harness a thread runs on cannot run a
 * turn: not installed, signed out, or failing its probe. It names the instance,
 * shows the command the connector said fixes it (copyable), and offers to
 * check again once the user has run it — a re-probe of every connector, the
 * same one Settings → Connectors runs.
 *
 * Nothing shows while the instance is ready or its first probe is still out,
 * nor for a thread whose instance is gone: the text is built only from the
 * summary (`connectorHealth`), so a harness the renderer has never heard of is
 * described the same way as one it has.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@OpenAde/ui/components/alert";
import { Button } from "@OpenAde/ui/components/button";
import type { ConnectorSummary } from "@OpenAde/contracts/connectors";
import type { ThreadDetailSnapshot } from "@OpenAde/contracts/orchestration";

import { CopyCommand } from "@/components/copy-command";
import { helpUrlFor } from "@/components/Settings/probe-help";
import { useAppAtoms } from "@/lib/app-runtime";
import { connectorHealth } from "@/lib/connector-health";
import { threadConnectorInstanceId } from "@/lib/connector-routing";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { AlertTriangle, Spinner } from "@honeyicons/react";

export function HarnessHealthBanner({
  summary,
  className,
}: {
  /** The instance the thread runs on, or would; undefined when there is none. */
  readonly summary: ConnectorSummary | undefined;
  readonly className?: string;
}) {
  const atoms = useAppAtoms();
  const probeAll = useAtomSet(atoms.probeConnectorsAtom, { mode: "promise" });
  const [checking, setChecking] = React.useState(false);

  if (summary === undefined) {
    return null;
  }
  const health = connectorHealth(summary);
  if (health.state === "ready" || health.state === "probing") {
    return null;
  }
  // Only a link the connector itself named: the docs fallback belongs on the
  // settings card, where the connector's description is at hand.
  const helpUrl = helpUrlFor(summary.probe, null);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await probeAll();
    } catch {
      // The banner stays up and the button comes back; nothing else to say.
    } finally {
      setChecking(false);
    }
  };

  return (
    <Alert className={cn("w-full", className)}>
      <AlertTriangle variant="bold" />
      <AlertTitle>{health.message}</AlertTitle>
      <AlertDescription>
        {health.command === null ? (
          <span>
            Fix it in Settings → Connectors, then check again.
            {helpUrl === null ? null : (
              <>
                {" "}
                <a
                  href={helpUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    openExternal(helpUrl);
                  }}
                >
                  Resolve
                </a>
              </>
            )}
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Run
            <CopyCommand command={health.command} />
            in a terminal, then check again.
          </span>
        )}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={checking}
          onClick={() => void checkAgain()}
        >
          {checking ? <Spinner variant="bold" /> : null}
          Check again
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** The banner for an open thread: its bound instance, else the one it would route to. */
export function ThreadHarnessBanner({
  snapshot,
  className,
}: {
  readonly snapshot: ThreadDetailSnapshot;
  readonly className?: string;
}) {
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const instanceId = threadConnectorInstanceId(
    snapshot.session?.connectorInstanceId ?? null,
    snapshot.settings.connectorInstanceId,
    connectors,
  );
  const summary = connectors.find((connector) => connector.connectorInstanceId === instanceId);
  return <HarnessHealthBanner summary={summary} className={className} />;
}
