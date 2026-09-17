/**
 * First-run flow: pick a project directory (the desktop's native picker, or a
 * typed path in the browser), let the server probe its connectors — installed,
 * signed in, reachable — and only then create the project and land in chat.
 * A failing probe offers the link `helpUrlFor` picks — the connector's own
 * `helpUrl` when it named one, the account page otherwise.
 *
 * The directory field is live, not commit-on-blur: this page is the only way
 * into a fresh install, "Create project" is gated on the field's value, and a
 * disabled button cannot be clicked to blur the field that would enable it.
 * `components/welcome/project-directory` holds that rule and its test.
 *
 * The page doubles as the connection diagnostic: the details card reports which
 * channel `resolveConnection` found (Electron preload, the dev endpoint, or
 * `?server=&token=` params) and the live connection state, so "am I connected
 * and to what" is one glance when the probe cannot reach the server at all.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import { Input } from "@OpenAde/ui/components/input";
import { makeCommandId, makeProjectId } from "@OpenAde/contracts/ids";
import type { ConnectorSummary } from "@OpenAde/contracts/rpc";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { Icon } from "@/lib/icon";
import { useAppAtoms } from "@/lib/app-runtime";
import { isAccepted, rejectionMessage } from "@/lib/dispatch-outcome";
import { openExternal, pickDirectory } from "@/lib/desktop";
import { projectNameFromPath } from "@/lib/workspace-path";
import { helpUrlFor } from "@/components/Settings/probe-help";
import {
  canCreateProject,
  directoryPicked,
  directoryProblem,
  directoryRejected,
  directoryTyped,
  emptyDirectory,
} from "@/components/welcome/project-directory";
import { getResolvedConnection } from "@/state/app-runtime";
import { useConnectionState } from "@/state/hooks";

export const Route = createFileRoute("/welcome")({
  component: WelcomePage,
});

const maskToken = (token: string): string =>
  token.length <= 8 ? "••••" : `${token.slice(0, 4)}…${token.slice(-4)}`;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 type-body text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

/** Where the renderer got its server from, and whether the socket is up. */
function ConnectionDetails() {
  const connection = useConnectionState();
  const resolved = getResolvedConnection();

  return (
    <Card size="sm" className="mt-4">
      <CardContent>
        <dl className="flex flex-col gap-2">
          <DetailRow label="Status" value={connection.status} />
          <DetailRow label="Server" value={resolved?.url ?? "none resolved"} />
          <DetailRow label="Token" value={resolved === null ? "—" : maskToken(resolved.token)} />
          <DetailRow label="Instance" value={connection.serverInstanceId ?? "—"} />
        </dl>
        {resolved === null ? (
          <p className="mt-3 type-body leading-relaxed text-muted-foreground">
            No connection channel answered at boot. Launch through the desktop app, run the dev
            server, or open{" "}
            <code className="rounded-sm bg-hover px-1 font-mono text-xs">
              ?server=ws://host:port&amp;token=…
            </code>
            .
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const probeSummary = (probe: ConnectorSummary["probe"]): string => {
  switch (probe.status) {
    case "ready":
      return probe.auth === "absent" ? "installed, not signed in" : "ready";
    case "not-installed":
      return "not installed";
    case "not-authenticated":
      return "not signed in";
    case "probing":
      return "probing…";
    default:
      return probe.message ?? "error";
  }
};

function WelcomePage() {
  const atoms = useAppAtoms();
  const navigate = useNavigate();
  const probeAll = useAtomSet(atoms.probeConnectorsAtom, { mode: "promise" });
  const dispatch = useAtomSet(atoms.dispatchAtom, { mode: "promiseExit" });

  const [directory, setDirectory] = React.useState(emptyDirectory);
  const [connectors, setConnectors] = React.useState<ReadonlyArray<ConnectorSummary> | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  // `window.openade` only exists under the desktop shell; read it once so the
  // button is simply absent in a browser tab rather than doing nothing.
  const [hasPicker] = React.useState(() => window.openade?.pickDirectory !== undefined);

  const browse = async () => {
    let picked: string | null;
    try {
      picked = await pickDirectory();
    } catch {
      toast.error("Could not open the directory picker");
      return;
    }
    if (picked === null) {
      return;
    }
    setDirectory(directoryPicked(picked));
    setConnectors(null);
  };

  const verify = async () => {
    setChecking(true);
    try {
      const list = await probeAll();
      setConnectors(list);
    } catch {
      toast.error("Could not reach the server to probe connectors");
    } finally {
      setChecking(false);
    }
  };

  const ready = connectors !== null && connectors.some((c) => c.probe.status === "ready");

  const problem = directoryProblem(directory);
  const canCreate = canCreateProject(directory, creating);

  const create = async () => {
    if (!canCreate) {
      return;
    }
    const root = directory.path.trim();
    const name = projectNameFromPath(root);
    setCreating(true);
    const exit = await dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "project.create",
      projectId: makeProjectId(),
      name: name === "" ? root : name,
      workspaceRoot: root,
    });
    setCreating(false);
    if (isAccepted(exit)) {
      void navigate({ to: "/" });
      return;
    }
    // The reason belongs under the field the user has to correct, not only in
    // a toast that scrolls away: "that directory does not exist" is about the
    // path, and the path is still on screen.
    const reason = rejectionMessage(exit, "The server rejected the project");
    setDirectory((current) => directoryRejected(current, reason));
    toast.error(reason);
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-6">
      <div className="w-full max-w-xl">
        <h1 className="text-2xl font-medium">Welcome to OpenAde</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a project directory, make sure a connector is installed and signed in, and start.
        </p>

        <Card size="sm" className="mt-6">
          <CardContent>
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-sm font-medium">Project directory</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The workspace the agent runs in.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Live, not commit-on-blur: "Create project" is gated on this
                    value and a disabled button cannot be clicked to blur the
                    field, which left a fresh install with no way forward. */}
                <Input
                  id="welcome-directory"
                  className="flex-1"
                  value={directory.path}
                  placeholder="/path/to/project"
                  autoFocus
                  aria-invalid={problem !== null}
                  aria-describedby={problem === null ? undefined : "welcome-directory-problem"}
                  onChange={(event) => {
                    setDirectory(directoryTyped(event.target.value));
                    setConnectors(null);
                  }}
                />
                {hasPicker ? (
                  <Button variant="outline" size="sm" onClick={() => void browse()}>
                    <Icon icon="hugeicons:folder-open" />
                    Browse…
                  </Button>
                ) : null}
              </div>
              {problem === null ? null : (
                <p
                  id="welcome-directory-problem"
                  role="alert"
                  className="-mt-2 type-micro text-destructive"
                >
                  {problem}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={checking}
                  onClick={() => void verify()}
                >
                  <Icon
                    icon="solar:refresh-linear"
                    className={checking ? "animate-spin" : undefined}
                  />
                  {checking ? "Checking…" : "Check connectors"}
                </Button>
                {connectors !== null && connectors.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No connectors configured — add one in Settings → Connectors.
                  </span>
                ) : null}
              </div>

              {connectors === null ? null : (
                <div className="flex flex-col gap-2">
                  {connectors.map((connector) => {
                    const help = helpUrlFor(connector.probe);
                    return (
                      <div
                        key={connector.connectorInstanceId}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Icon
                          icon={
                            connector.probe.status === "ready"
                              ? "hugeicons:checkmark-circle-01"
                              : "hugeicons:alert-02"
                          }
                          className={
                            connector.probe.status === "ready" ? "text-added" : "text-removed"
                          }
                        />
                        <span className="font-medium">{connector.displayName}</span>
                        <span className="text-muted-foreground">
                          {probeSummary(connector.probe)}
                        </span>
                        {help === null ? null : (
                          <button
                            type="button"
                            className="text-xs text-primary underline underline-offset-2"
                            onClick={() => openExternal(help)}
                          >
                            Resolve
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <ConnectionDetails />

        <div className="mt-6 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {ready ? "A connector is ready." : "You can continue once a directory is chosen."}
          </p>
          <Button onClick={() => void create()} disabled={!canCreate}>
            {creating ? "Creating…" : "Create project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
