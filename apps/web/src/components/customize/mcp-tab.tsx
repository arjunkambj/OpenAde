/**
 * The MCP tab: everything `cmdConfig.mcp.list` returns for the chosen scope.
 * Entries carrying the `_openade` marker are edited and removed here; entries
 * without it are shown read-only — the server refuses to touch them anyway,
 * and the marker rule is what keeps a hand edit safe across a round-trip.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@OpenAde/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@OpenAde/ui/components/dropdown-menu";
import type { McpServerConfig } from "@OpenAde/contracts/rpc";
import * as Exit from "effect/Exit";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { Icon } from "@/lib/icon";

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

const describeServer = (server: McpServerConfig): string =>
  server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
    : (server.url ?? "");

export function McpTab() {
  const atoms = useAppAtoms();
  const projectId = useCustomizeScope();
  const serversResult = useAtomValue(atoms.mcpServersAtom(projectId));
  const remove = useAtomSet(atoms.mcpRemoveAtom, { mode: "promiseExit" });
  const [query, setQuery] = React.useState("");
  const [dialog, setDialog] = React.useState<{
    open: boolean;
    editing: McpServerConfig | null;
  }>({ open: false, editing: null });
  const [removing, setRemoving] = React.useState<McpServerConfig | null>(null);

  const servers = AsyncResult.isSuccess(serversResult) ? serversResult.value : null;
  const shown =
    servers?.filter((server) => matchesQuery(query, [server.name, describeServer(server)])) ?? null;

  const removeServer = async (server: McpServerConfig) => {
    const exit = await remove({ projectId, scope: server.scope, name: server.name });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not remove server"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <CustomizeSearch value={query} onChange={setQuery} placeholder="Search MCP servers" />
        <Button variant="outline" onClick={() => setDialog({ open: true, editing: null })}>
          <Icon icon="hugeicons:add-01" />
          Add server
        </Button>
      </div>

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
              icon="hugeicons:server-stack-01"
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
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${server.name}`}
                        />
                      }
                    >
                      <Icon icon="hugeicons:more-vertical" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDialog({ open: true, editing: server })}>
                        <Icon icon="hugeicons:edit-02" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(server)}>
                        <Icon icon="hugeicons:delete-02" />
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

      <McpServerDialog
        open={dialog.open}
        editing={dialog.editing}
        projectId={projectId}
        canUseProjectScope={projectId !== null}
        onClose={() => setDialog({ open: false, editing: null })}
      />

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
            : `Its entry is deleted from the ${removing.scope === "project" ? "project's .mcp.json" : "global mcp.json"}, and sessions started after this will not launch it.`
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
