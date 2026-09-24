/**
 * The MCP tab: one section per connector instance with an MCP servers
 * extension, each listing what `connectors.mcp.list` returns for the chosen
 * scope. Entries the instance marks `managed` are edited and removed here;
 * the rest are shown read-only — the connector refuses to touch them anyway,
 * and that rule is what keeps a hand edit safe across a round-trip.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { McpServerConfig } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";

import { CustomizeInstances } from "./customize-instances";
import { useCustomizeScope } from "./customize-layout";
import {
  CustomizeCard,
  CustomizeEmpty,
  CustomizeSearch,
  CustomizeSection,
  CustomizeTag,
  matchesQuery,
} from "./customize-list";
import { McpServerDialog } from "./mcp-server-dialog";
import { Add as AddIcon, Edit as EditIcon, MoreVertical, Server, Trash } from "@honeyicons/react";

const describeServer = (server: McpServerConfig): string =>
  server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : (server.url ?? "");

export function McpTab() {
  const [query, setQuery] = React.useState("");
  // The instance outlives `open`, so the dialog can animate closed.
  const [dialog, setDialog] = React.useState<{
    readonly open: boolean;
    readonly instanceId: ConnectorInstanceId | null;
    readonly editing: McpServerConfig | null;
  }>({ open: false, instanceId: null, editing: null });
  const projectId = useCustomizeScope();

  return (
    <div className="flex flex-col gap-8">
      <CustomizeSearch value={query} onChange={setQuery} placeholder="Search MCP servers" />
      <CustomizeInstances
        kind="mcpServers"
        empty="No enabled connector manages MCP servers."
        actions={(instance) => (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDialog({ open: true, instanceId: instance.connectorInstanceId, editing: null })
            }
          >
            <AddIcon variant="bold" />
            Add server
          </Button>
        )}
      >
        {(instance) => (
          <InstanceServers
            instanceId={instance.connectorInstanceId}
            query={query}
            onEdit={(server) =>
              setDialog({ open: true, instanceId: instance.connectorInstanceId, editing: server })
            }
          />
        )}
      </CustomizeInstances>

      {dialog.instanceId === null ? null : (
        <McpServerDialog
          open={dialog.open}
          editing={dialog.editing}
          instanceId={dialog.instanceId}
          projectId={projectId}
          canUseProjectScope={projectId !== null}
          onClose={() => setDialog((current) => ({ ...current, open: false }))}
        />
      )}
    </div>
  );
}

function InstanceServers({
  instanceId,
  query,
  onEdit,
}: {
  readonly instanceId: ConnectorInstanceId;
  readonly query: string;
  readonly onEdit: (server: McpServerConfig) => void;
}) {
  const atoms = useAppAtoms();
  const projectId = useCustomizeScope();
  const serversResult = useAtomValue(atoms.mcpServersAtom(instanceId)(projectId));
  const remove = useAtomSet(atoms.mcpRemoveAtom, { mode: "promiseExit" });
  const [removing, setRemoving] = React.useState<McpServerConfig | null>(null);

  const servers = AsyncResult.isSuccess(serversResult) ? serversResult.value : null;
  const shown =
    servers?.filter((server) => matchesQuery(query, [server.name, describeServer(server)])) ?? null;

  const removeServer = async (server: McpServerConfig) => {
    const exit = await remove({ instanceId, projectId, scope: server.scope, name: server.name });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not remove server"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <CustomizeSection title="Configured" count={servers?.length ?? null}>
        {shown === null ? (
          <CustomizeEmpty>Loading…</CustomizeEmpty>
        ) : servers?.length === 0 ? (
          <CustomizeEmpty>No MCP servers configured.</CustomizeEmpty>
        ) : shown.length === 0 ? (
          <CustomizeEmpty>No servers match “{query.trim()}”.</CustomizeEmpty>
        ) : (
          shown.map((server) => (
            <CustomizeCard
              key={`${server.scope}:${server.name}`}
              icon={Server}
              title={server.name}
              muted={!server.enabled}
              tags={
                <>
                  {server.enabled ? null : <CustomizeTag>Disabled</CustomizeTag>}
                  {server.managed === true ? null : <CustomizeTag>Managed by hand</CustomizeTag>}
                  <CustomizeTag>{server.scope === "project" ? "Project" : "Global"}</CustomizeTag>
                  <CustomizeTag mono>{server.transport}</CustomizeTag>
                </>
              }
              actions={
                server.managed === true ? (
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Actions for ${server.name}`}
                              />
                            }
                          />
                        }
                      >
                        <MoreVertical variant="bold" />
                      </TooltipTrigger>
                      <TooltipContent>More actions</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit(server)}>
                        <EditIcon variant="bold" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(server)}>
                        <Trash variant="bold" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : undefined
              }
              detail={describeServer(server)}
            />
          ))
        )}
      </CustomizeSection>

      {/* Removing an entry rewrites the connector's config file; there is no
          undo, so it asks first the way the restore dialog does. */}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRemoving(null);
          }
        }}
        title={removing === null ? "Remove server?" : `Remove ${removing.name}?`}
        description={
          removing === null
            ? ""
            : `Its entry is deleted from the connector's ${removing.scope === "project" ? "project" : "global"} config, and sessions started after this will not launch it.`
        }
        confirmLabel="Remove server"
        onConfirm={() => {
          if (removing === null) {
            return;
          }
          const server = removing;
          setRemoving(null);
          void removeServer(server);
        }}
      />
    </div>
  );
}
