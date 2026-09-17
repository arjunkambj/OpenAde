/**
 * The MCP servers page: everything `cmdConfig.mcp.list` returns for the
 * chosen project context, grouped by the file it lives in. Entries carrying
 * the `_openade` marker are edited and removed here; entries without it are
 * shown read-only — the server refuses to touch them anyway, and the marker
 * rule is what keeps a hand edit safe across a round-trip.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import { Card, CardContent } from "@OpenAde/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@OpenAde/ui/components/select";
import type { ProjectId } from "@OpenAde/contracts/ids";
import type { McpServerConfig } from "@OpenAde/contracts/rpc";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

import { McpServerDialog } from "./mcp-server-dialog";

/** The select's value for "no project" — `null` is base-ui's empty state. */
const USER_SCOPE = "__user__";

const describeServer = (server: McpServerConfig): string =>
  server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : (server.url ?? "");

export function McpPanel() {
  const atoms = useAppAtoms();
  const projectsResult = useAtomValue(atoms.projectsAtom);
  const [projectId, setProjectId] = React.useState<ProjectId | null>(null);
  const serversResult = useAtomValue(atoms.mcpServersAtom(projectId));
  const remove = useAtomSet(atoms.mcpRemoveAtom, { mode: "promiseExit" });
  const [dialog, setDialog] = React.useState<{
    open: boolean;
    editing: McpServerConfig | null;
  }>({ open: false, editing: null });

  const projects = AsyncResult.isSuccess(projectsResult) ? projectsResult.value : [];
  const servers = AsyncResult.isSuccess(serversResult) ? serversResult.value : [];

  const removeServer = async (server: McpServerConfig) => {
    const exit = await remove({ projectId, scope: server.scope, name: server.name });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not remove server"));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">MCP servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Servers the connector launches at session start. OpenAde writes them with an ownership
            marker; anything else in the file is yours.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={projectId ?? USER_SCOPE}
            onValueChange={(next) => setProjectId(next === USER_SCOPE ? null : (next as ProjectId))}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="User scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={USER_SCOPE}>User scope</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.projectId} value={project.projectId}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ open: true, editing: null })}
          >
            <Icon icon="hugeicons:add-01" />
            Add server
          </Button>
        </div>
      </div>

      <Card size="sm">
        <CardContent>
          <div className="flex flex-col divide-y divide-border/60">
            {servers.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">No MCP servers configured.</p>
            ) : (
              servers.map((server) => {
                const managed = server.managed === true;
                return (
                  <div
                    key={`${server.scope}:${server.name}`}
                    className="flex items-center gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{server.name}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {server.transport}
                        </span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {server.scope}
                        </span>
                        {!server.enabled ? (
                          <span className="text-xs text-muted-foreground">disabled</span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {describeServer(server)}
                      </p>
                    </div>
                    {managed ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ open: true, editing: server })}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${server.name}`}
                          onClick={() => void removeServer(server)}
                        >
                          <Icon icon="hugeicons:delete-02" />
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">managed by hand</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <McpServerDialog
        open={dialog.open}
        editing={dialog.editing}
        projectId={projectId}
        canUseProjectScope={projectId !== null}
        onClose={() => setDialog({ open: false, editing: null })}
      />
    </div>
  );
}
